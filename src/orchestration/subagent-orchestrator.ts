import { fileURLToPath } from "node:url";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getCachedAgentDiscovery } from "../agent/agent-cache.js";
import type {
  AgentConfig,
  AgentScope,
  ThinkingLevel,
} from "../agent/agents.js";
import {
  buildModelDisplay,
  type ModelRegistry as ChildModelRegistry,
  resolveEffectiveChildModelSettings,
  resolveThinkingLevel,
} from "../child/model-resolution.js";
import { runSingleAgent } from "../child/process.js";
import { deliverNotification } from "../notification/delivery.js";
import {
  buildNotificationRequest,
  isDesktopNotificationsEnabled,
  isPerJobNotificationEnabled,
} from "../notification/desktop-notification.js";
import {
  formatSubagentFailureForParent,
  formatSubagentResultForParent,
} from "../output/summary.js";
import { refreshBackgroundActivity } from "../progress/background-activity.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  patchProgressState,
} from "../progress/progress.js";
import {
  createSubagentError,
  type DetailsOptions,
  getFeedbackSummaryText,
  getLatestResult,
  patchProgressFromDetails,
  sanitizeDetailsForDisplay,
  sanitizeResultDetails,
} from "../progress/result-details.js";
import {
  discoverRoles,
  normalizeRoleRequest,
  type RoleResolution,
  resolveRole,
  roleMetadata,
} from "../roles/index.js";
import { generateSubagentInstanceName } from "../shared/instance-name.js";
import { getPiInvocation, getSubagentDepth } from "../shared/invocation.js";
import type {
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
} from "../shared/types.js";
import { hasSubagentFailed } from "../shared/utils.js";
import { sendCompletionMessage } from "./completion-delivery.js";
import { formatHandoffTask } from "./handoff-task.js";
import {
  listRunJobs,
  type RunJob,
  registerRunJob,
  removeRunJob,
} from "./run-registry.js";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "both" (user + project-local agents).',
  default: "both",
});

export const SubagentParams = Type.Object({
  role: Type.Optional(
    Type.String({
      description:
        "Omitted/default uses this child's agent role; none disables it; a role ID overrides this invocation only. Never inherits the parent role.",
    }),
  ),
  agent: Type.String({
    description: "Name of the agent to invoke",
  }),
  task: Type.Optional(
    Type.String({
      description:
        "Readable task to delegate. With ticketPath, use only for supplemental instructions; preserve normal spaces between words. Optional for agents with defaults.",
    }),
  ),
  ticketPath: Type.Optional(
    Type.String({
      description:
        "Absolute path to the saved ticket. The child reads the full ticket; prefer this over restating its contents in task.",
    }),
  ),
  worktreePath: Type.Optional(
    Type.String({
      description:
        "Absolute worktree path for the child to use. Omit when the current working directory is correct.",
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  debug: Type.Optional(
    Type.Boolean({
      description:
        "Internal debug option. Include full child messages in result details.",
      default: false,
    }),
  ),
});

export type { SubagentToolResult };

type DetailsBuilder = (
  results: SingleResult[],
  options?: DetailsOptions,
) => SubagentDetails;

function isDebugDetailsAuthorized(debugRequested: boolean): boolean {
  return debugRequested && process.env.PI_SUBAGENT_DEBUG_ENABLED === "1";
}

interface LifecycleContext {
  role: RoleResolution;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  requestId: string;
  job: RunJob;
  debug: boolean;
  makeDetails: DetailsBuilder;
  mergedSignal: AbortSignal;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  parentModel: { provider: string; id: string } | undefined;
  parentThinking: ThinkingLevel;
  registry?: ChildModelRegistry;
  hostOnUpdate?: AgentToolUpdateCallback<SubagentDetails> | undefined;
}

function createDetailsBuilder(
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  includeDebugMessages: boolean,
): DetailsBuilder {
  return (results, options) => ({
    mode: "single",
    agentScope,
    projectAgentsDir,
    results: results.map((result) =>
      sanitizeResultDetails(result, includeDebugMessages, options),
    ),
  });
}

function createProgressRenderRequester(
  ctx: ExtensionContext,
  requestId: string,
  pi: ExtensionAPI,
): () => void {
  const progressRenderKey = `subagent-progress:${requestId}`;
  return () => {
    publishBackgroundActivity(ctx, pi);
    ctx.ui?.setStatus?.(progressRenderKey, `${Date.now()}`);
    ctx.ui?.setStatus?.(progressRenderKey, undefined);
  };
}

function publishBackgroundActivity(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const states = listRunJobs()
    .filter((job) => job.sessionId === sessionId)
    .flatMap((job) => {
      const state = getProgressState(job.requestId);
      return state ? [state] : [];
    });
  refreshBackgroundActivity(ctx, pi, states);
}

function cancelStartedJob(job: RunJob, reason: string): void {
  cancelProgressState(job.requestId, reason);
  removeRunJob(job.requestId);
}

function sendSubagentResultMessage(
  lc: LifecycleContext,
  content: string,
  details: SubagentDetails,
): void {
  sendCompletionMessage(
    lc.pi,
    lc.ctx,
    lc.job.sessionId ?? lc.ctx.sessionManager?.getSessionId?.() ?? "",
    getSubagentDepth(),
    content,
    details,
  );
}

function deliverDesktopCompletionNotification(
  state: NonNullable<ReturnType<typeof getProgressState>>,
): void {
  if (state.status === "cancelled") return;
  const request = buildNotificationRequest(state);
  deliverNotification(request).catch(() => {});
}

export function emitCompletionAlert(
  state: ReturnType<typeof getProgressState>,
): void {
  if (!state) return;
  if (state.status === "cancelled") return;
  if (
    isDesktopNotificationsEnabled() &&
    !isPerJobNotificationEnabled() &&
    getSubagentDepth() === 0
  ) {
    deliverDesktopCompletionNotification(state);
  }
  const tty = (process.stdout as { isTTY?: boolean }).isTTY;
  if (!tty) return;
  process.stdout.write("\x07");
}

function createCompletedToolResult(
  content: string,
  details: SubagentDetails,
): SubagentToolResult {
  return {
    content: [{ type: "text", text: content }],
    details: { ...details, renderedByMessage: true },
  };
}

function finishLifecycleFailure(
  lc: LifecycleContext,
  errorMessage: string,
  details: SubagentDetails,
): SubagentToolResult {
  const displayDetails = sanitizeDetailsForDisplay(details, lc.debug);
  if (lc.mergedSignal.aborted) {
    cancelProgressState(lc.requestId, lc.job.cancelReason ?? errorMessage);
    if (getSubagentDepth() > 0) {
      sendSubagentResultMessage(lc, "Canceled", displayDetails);
    }
    return createCompletedToolResult("Canceled", displayDetails);
  }
  failProgressState(lc.requestId, errorMessage);
  lc.ctx.ui?.notify?.(errorMessage, "error");
  const latestResult = getLatestResult(details);
  const content = formatSubagentFailureForParent(errorMessage, latestResult);
  sendSubagentResultMessage(lc, content, displayDetails);
  return createCompletedToolResult(content, displayDetails);
}

function finishLifecycleResult(
  lc: LifecycleContext,
  result: SingleResult,
): SubagentToolResult {
  const details = lc.makeDetails([result]);
  if (hasSubagentFailed(result)) {
    return finishLifecycleFailure(
      lc,
      lc.mergedSignal.aborted ? "Aborted" : createSubagentError(result).message,
      details,
    );
  }
  const displayDetails = sanitizeDetailsForDisplay(details, lc.debug);
  const content = formatSubagentResultForParent(result) || "(no output)";
  const toolResult = createCompletedToolResult(content, displayDetails);
  finalizeProgressState(
    lc.requestId,
    getFeedbackSummaryText(toolResult),
    result.outcome,
  );
  sendSubagentResultMessage(lc, content, displayDetails);
  return toolResult;
}

function createPayloadFingerprint(payload: {
  content: { type: string; text?: string }[];
  details: SubagentDetails;
}): string {
  const contentText = payload.content[0]?.text ?? "";
  const latestResult = payload.details.results[0];
  const activityText = latestResult?.progress?.activityText ?? "";
  const toolCallIds = [
    ...new Set(latestResult?.progress?.toolCalls?.map((tc) => tc.id)),
  ]
    .sort()
    .join(",");
  const exitCode = latestResult?.exitCode ?? 0;
  const stopReason = latestResult?.stopReason ?? "";
  return `${contentText}|${activityText}|${toolCallIds}|${exitCode}|${stopReason}`;
}

async function runSubagentLifecycle(
  lc: LifecycleContext,
): Promise<SubagentToolResult> {
  const seenToolCallIds = new Set<string>();
  const requestProgressRender = createProgressRenderRequester(
    lc.ctx,
    lc.requestId,
    lc.pi,
  );
  let lastDeliveredFingerprint: string | undefined;
  const onUpdate: OnUpdateCallback = (result) => {
    patchProgressFromDetails(lc.requestId, result.details, seenToolCallIds);
    requestProgressRender();
    if (lc.hostOnUpdate) {
      const sanitizedDetails = sanitizeDetailsForDisplay(
        result.details,
        lc.debug,
      );
      const { renderedByMessage, ...partialDetails } = sanitizedDetails;
      const payload = {
        content: result.content,
        details: partialDetails,
      };
      const fingerprint = createPayloadFingerprint(payload);
      if (fingerprint !== lastDeliveredFingerprint) {
        lastDeliveredFingerprint = fingerprint;
        lc.hostOnUpdate(payload);
      }
    }
  };
  const timerTick = setInterval(requestProgressRender, 500);
  try {
    const outcome = await runSingleAgent(
      lc.ctx.cwd,
      lc.agents,
      lc.agentName,
      lc.task,
      lc.mergedSignal,
      onUpdate,
      lc.makeDetails,
      lc.parentModel,
      lc.parentThinking,
      lc.debug,
      { registry: lc.registry, role: lc.role },
    );
    if (outcome.kind === "aborted") {
      const details = lc.makeDetails([outcome.result]);
      const cancelReason =
        outcome.result.termination?.cancelReason ?? "Aborted";
      return finishLifecycleFailure(lc, cancelReason, details);
    }
    return finishLifecycleResult(lc, outcome.result);
  } catch (error) {
    return finishLifecycleFailure(
      lc,
      error instanceof Error ? error.message : String(error),
      lc.makeDetails([]),
    );
  } finally {
    clearInterval(timerTick);
    requestProgressRender();
    removeRunJob(lc.requestId);
    const state = getProgressState(lc.requestId);
    if (state) deliverLifecycleCompletionNotification(state);
  }
}

function deliverLifecycleCompletionNotification(
  state: NonNullable<ReturnType<typeof getProgressState>>,
): void {
  if (
    isDesktopNotificationsEnabled() &&
    isPerJobNotificationEnabled() &&
    getSubagentDepth() === 0
  ) {
    deliverDesktopCompletionNotification(state);
    return;
  }
  if (listRunJobs().length === 0) emitCompletionAlert(state);
}

type StartJobResult =
  | {
      kind: "started";
      requestId: string;
      instanceName: string;
      makeDetails: DetailsBuilder;
    }
  | { kind: "completed"; result: SubagentToolResult }
  | { kind: "cancelled"; makeDetails: DetailsBuilder }
  | { kind: "not_found"; makeDetails: DetailsBuilder };

type PrepareSubagentJobResult =
  | {
      kind: "ready";
      lc: LifecycleContext;
      instanceName: string;
      requestProgressRender: () => void;
      hostOnUpdate?: AgentToolUpdateCallback<SubagentDetails> | undefined;
    }
  | { kind: "not_found"; makeDetails: DetailsBuilder }
  | { kind: "cancelled"; makeDetails: DetailsBuilder };

export function formatSubagentToolResult(
  agentName: string,
  result: StartJobResult,
): SubagentToolResult {
  if (result.kind === "completed") return result.result;
  let text: string;
  if (result.kind === "not_found") text = `Unknown agent: "${agentName}"`;
  else if (result.kind === "cancelled") text = "Canceled";
  else
    text = `Subagent ${agentName} ${result.instanceName} started (job: ${result.requestId})`;
  return {
    content: [{ type: "text", text }],
    details: result.makeDetails([]),
  };
}

function needsProjectAgentConfirmation(
  ctx: ExtensionContext,
  agent: AgentConfig,
): boolean {
  return ctx.hasUI && agent.source === "project";
}

function confirmProjectAgentRun(
  ctx: ExtensionContext,
  agent: AgentConfig,
  projectAgentsDir: string | null,
): Promise<boolean> {
  const dir = projectAgentsDir ?? "(unknown)";
  return ctx.ui.confirm(
    "Run project-local agent?",
    `Agent: ${agent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
}

async function prepareSubagentJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  hostSignal: AbortSignal | undefined,
  hostOnUpdate?: AgentToolUpdateCallback<SubagentDetails>,
): Promise<PrepareSubagentJobResult> {
  const agentScope: AgentScope = params.agentScope ?? "both";
  normalizeRoleRequest(params.role);
  const discovery = await getCachedAgentDiscovery(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const debug = isDebugDetailsAuthorized(params.debug === true);
  const makeDetails = createDetailsBuilder(
    agentScope,
    discovery.projectAgentsDir,
    debug,
  );
  const requested = agents.find((a) => a.name === params.agent);
  if (!requested) return { kind: "not_found", makeDetails };
  if (hostSignal?.aborted) return { kind: "cancelled", makeDetails };
  const task = formatHandoffTask(params);
  if (needsProjectAgentConfirmation(ctx, requested)) {
    const confirmed = await confirmProjectAgentRun(
      ctx,
      requested,
      discovery.projectAgentsDir,
    );
    if (!confirmed) return { kind: "cancelled", makeDetails };
  }
  const catalog = await discoverRoles({
    cwd: ctx.cwd,
    allowProject: ctx.isProjectTrusted?.() ?? !ctx.hasUI,
  });
  const role = resolveRole(catalog, requested.role, params.role);
  if (
    role.source === "project" &&
    requested.source !== "project" &&
    ctx.hasUI
  ) {
    const confirmed = await ctx.ui.confirm(
      "Run project-local role?",
      `Role: ${role.displayName}\nSource: ${catalog.projectRoot}\n\nProject roles are repo-controlled. Only continue for trusted repositories.`,
    );
    if (!confirmed) return { kind: "cancelled", makeDetails };
  }
  const metadata = roleMetadata(role);
  if (requested.source === "project") {
    const userAgents = await getCachedAgentDiscovery(ctx.cwd, "user");
    const hasUserCollision = userAgents.agents.some(
      (a) => a.name === requested.name,
    );
    if (hasUserCollision) {
      pi.sendMessage({
        customType: "subagent-progress",
        content: `Using project agent "${requested.name}"; user agent with same name also exists.`,
        display: true,
        details: {},
      });
    }
  }
  const parentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;
  const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
  const requestId = crypto.randomUUID();
  const instanceName = generateSubagentInstanceName();
  const controller = new AbortController();
  const job: RunJob = registerRunJob({
    sessionId: ctx.sessionManager?.getSessionId?.(),
    requestId,
    agentName: params.agent,
    instanceName,
    controller,
    startedAt: Date.now(),
    role: metadata,
  });
  const mergedSignal = hostSignal
    ? AbortSignal.any([hostSignal, job.controller.signal])
    : job.controller.signal;
  const makeStartedDetails: DetailsBuilder = (results, options) =>
    makeDetails(
      results.map((result) => ({ ...result, instanceName, role: metadata })),
      options,
    );
  createProgressState(requestId, requested.name, task, instanceName, metadata);
  const effectiveModel = resolveEffectiveChildModelSettings(
    requested,
    parentModel,
  );
  const resolvedThinking = resolveThinkingLevel(
    requested.thinking ?? parentThinking,
    effectiveModel.provider,
    effectiveModel.id,
    { registry: ctx.modelRegistry },
  );
  patchProgressState(requestId, {
    modelDisplay: buildModelDisplay(effectiveModel, resolvedThinking.level),
  });
  publishBackgroundActivity(ctx, pi);
  pi.sendMessage({
    customType: "subagent-progress",
    content: "",
    display: true,
    details: { agent: params.agent, instanceName, requestId, role: metadata },
  });
  const requestProgressRender = createProgressRenderRequester(
    ctx,
    requestId,
    pi,
  );
  if (mergedSignal.aborted) {
    cancelStartedJob(job, job.cancelReason ?? "Aborted");
    requestProgressRender();
    return { kind: "cancelled", makeDetails: makeStartedDetails };
  }
  return {
    kind: "ready",
    lc: {
      pi,
      role,
      ctx,
      requestId,
      job,
      debug,
      makeDetails: makeStartedDetails,
      mergedSignal,
      agents,
      agentName: params.agent,
      task,
      parentModel,
      parentThinking,
      registry: ctx.modelRegistry,
      hostOnUpdate,
    },
    instanceName,
    requestProgressRender,
    hostOnUpdate,
  };
}

export async function startSubagentJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  hostSignal: AbortSignal | undefined,
  hostOnUpdate?: AgentToolUpdateCallback<SubagentDetails>,
): Promise<StartJobResult> {
  const prepared = await prepareSubagentJob(
    pi,
    ctx,
    params,
    hostSignal,
    hostOnUpdate,
  );
  if (prepared.kind !== "ready") return prepared;
  const { lc, instanceName, requestProgressRender } = prepared;
  if (getSubagentDepth() > 0) {
    const result = await runSubagentLifecycle(lc);
    return { kind: "completed", result };
  }
  let durableStart:
    | ((job: Record<string, unknown>, adapterPath: string) => Promise<unknown>)
    | undefined;
  pi.events?.emit("rodrigojager:pi-agent-mailbox:request:v1", {
    context: ctx,
    accept: (start: typeof durableStart) => {
      durableStart = start;
    },
  });
  if (durableStart) {
    const requestedAgent = lc.agents.find(
      (agent) => agent.name === lc.agentName,
    );
    if (!requestedAgent)
      throw new Error(
        `Subagent ${lc.agentName} disappeared during preparation`,
      );
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) throw new Error("Mailbox start requires a Pi session ID");
    const details = lc.makeDetails([]);
    const job = {
      jobId: lc.requestId,
      coordinatorId: sessionId,
      workflowId: sessionId,
      depth: getSubagentDepth(),
      cwd: ctx.cwd,
      agent: requestedAgent,
      task: lc.task,
      role: lc.role,
      agentScope: details.agentScope,
      projectAgentsDir: details.projectAgentsDir,
      parentModel: lc.parentModel,
      parentThinking: lc.parentThinking,
      debug: lc.debug,
      instanceName,
      piInvocation: getPiInvocation([]),
    };
    const adapterPath = fileURLToPath(
      new URL("../mailbox/worker-adapter.ts", import.meta.url),
    );
    let cancelDelivered = false;
    const requestCancel = async () => {
      if (cancelDelivered) return;
      let cancel: ((jobId: string) => Promise<unknown>) | undefined;
      pi.events?.emit("rodrigojager:pi-agent-mailbox:cancel:v1", {
        context: ctx,
        sessionId,
        accept: (handler: typeof cancel) => {
          cancel = handler;
        },
      });
      if (cancel) {
        try {
          await cancel(lc.requestId);
          cancelDelivered = true;
        } catch {
          /* A later retry can reconcile an uncertain cancellation. */
        }
      }
    };
    lc.mergedSignal.addEventListener(
      "abort",
      () => {
        void requestCancel();
      },
      { once: true },
    );
    try {
      await durableStart(job, adapterPath);
    } catch (error) {
      // A lost start response is ambiguous. Never launch the same job locally.
      failProgressState(
        lc.requestId,
        `Mailbox start uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
      requestProgressRender();
      throw error;
    }
    if (lc.mergedSignal.aborted) await requestCancel();
    return {
      kind: "started",
      requestId: lc.requestId,
      instanceName,
      makeDetails: lc.makeDetails,
    };
  }
  setImmediate(() => {
    if (lc.mergedSignal.aborted) {
      cancelStartedJob(lc.job, lc.job.cancelReason ?? "Aborted");
      requestProgressRender();
      return;
    }
    runSubagentLifecycle(lc);
  });
  return {
    kind: "started",
    requestId: lc.requestId,
    instanceName,
    makeDetails: lc.makeDetails,
  };
}
