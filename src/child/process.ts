/**
 * Manages subagent execution by spawning and orchestrating child `pi` processes.
 * Handles JSON-mode event streaming, resource tracking, and lifecycle management
 * including timeouts and termination signals.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, ThinkingLevel } from "../agent/agents.js";
import { getFinalOutput } from "../output/ui.js";
import { roleMetadata } from "../roles/resolver.js";
import type { RoleResolution } from "../roles/types.js";
import { getPiInvocation, getSubagentDepth } from "../shared/invocation.js";
import {
  type OnUpdateCallback,
  type SingleResult,
  type SubagentDetails,
  TOOL_RESULT_FAILED_MESSAGE,
} from "../shared/types.js";
import {
  detectMessageError,
  getSubagentRuntimeLimits,
  resolveAgentExtensionPaths,
  resolveAgentSkillArgs,
} from "../shared/utils.js";
import { getLatestOutcomeFromMessages } from "./complete-outcome.js";
import {
  clearGraceTimer,
  makeRequestTerminator,
  type SubagentState,
  setupChildProcess,
} from "./event-stream.js";
import {
  buildModelDisplay,
  type ChildModelSettings,
  type ModelRegistry,
  resolveEffectiveChildModelSettings,
  resolveThinkingLevel,
} from "./model-resolution.js";
import { buildChildEnv, buildPiArgs, buildSamplingEnv } from "./pi-args.js";
import {
  beginPromptSetup,
  cleanupPromptSetupResult,
  cleanupTempPrompt,
} from "./prompt-setup.js";
import {
  createErrorResult,
  errorForDepthLimit,
  errorForUnknownAgent,
  initRuntimeResult,
  type RuntimeResult,
} from "./result-builder.js";
import { makeEmitUpdate } from "./streaming-progress.js";
import {
  acquireChildSleepInhibitor,
  getProcessTreeSpawnOptions,
  isFinitePid,
  makeHostSleepInhibitorAdapter,
  type SleepInhibitorHandle,
} from "./termination.js";

export { makeEmitUpdate } from "./streaming-progress.js";

type SleepInhibitorAcquirer = (pid: number) => Promise<SleepInhibitorHandle>;

type RunSingleAgentOptions = {
  role?: RoleResolution | undefined;
  acquireSleepInhibitor?: SleepInhibitorAcquirer;
  getOrchestratorPid?: () => unknown;
  registry?: ModelRegistry | undefined;
};

export type RunSingleAgentResult =
  | { kind: "completed"; result: SingleResult }
  | { kind: "aborted"; result: SingleResult };

function getAbortReason(signal: AbortSignal): string {
  const { reason } = signal;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "abort";
}

const hostSleepInhibitorAdapter = makeHostSleepInhibitorAdapter();

async function acquireDefaultSleepInhibitor(
  pid: number,
): Promise<SleepInhibitorHandle> {
  return acquireChildSleepInhibitor(pid, hostSleepInhibitorAdapter);
}

async function acquireSubagentSleepInhibitor(
  pid: number,
  acquireSleepInhibitor: SleepInhibitorAcquirer,
): Promise<SleepInhibitorHandle | undefined> {
  try {
    return await acquireSleepInhibitor(pid);
  } catch {
    /* acquisition failures degrade gracefully to no inhibitor */
    return undefined;
  }
}

function getValidatedOrchestratorPid(
  options: RunSingleAgentOptions,
): number | undefined {
  try {
    const pid = options.getOrchestratorPid
      ? options.getOrchestratorPid()
      : process.pid;
    return isFinitePid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function releaseSleepInhibitor(
  handle: SleepInhibitorHandle | undefined,
): Promise<void> {
  if (!handle) return;
  try {
    await handle.release();
  } catch {
    /* release failures are non-fatal */
  }
}

function startSleepInhibitorRelease(
  acquisitionPromise: Promise<SleepInhibitorHandle | undefined>,
): Promise<void> {
  return acquisitionPromise.then(releaseSleepInhibitor, () => {});
}

export function hasCompletedAgentOutput(
  result: RuntimeResult,
  outcome?: string,
): boolean {
  if (result.finalOutput.trim()) return true;
  if (outcome?.trim()) return true;
  return getFinalOutput(result.messages).trim().length > 0;
}

/**
 * Rationale: `pi` processes in JSON mode might hang after finishing their task;
 * we force-kill them after a grace period and treat it as success (0) if they
 * actually produced output.
 */
export function getAgentEndTimeoutExitCode(
  result: RuntimeResult,
  spawnError: Error | undefined,
  outcome: string | undefined,
): number | undefined {
  if (result.termination?.cancelReason !== "agent_end_timeout") return;
  if (spawnError) return;
  if (result.stopReason === "error" || result.stopReason === "aborted") return;
  if (result.errorMessage?.trim()) return;
  return hasCompletedAgentOutput(result, outcome) ? 0 : 1;
}

/**
 * Safety: Implements a dual-timer strategy (idle and hard) to ensure streams
 * are destroyed and promises settled even if the process or its pipes hang.
 */
function createProcessCleanup(proc: ChildProcess, idleMs: number) {
  let idleTimer: NodeJS.Timeout | undefined;
  const destroyStreams = () => {
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  };
  return {
    armIdleTimer: () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(destroyStreams, idleMs);
      idleTimer.unref?.();
    },
    clearIdleTimer: () => {
      if (idleTimer) clearTimeout(idleTimer);
    },
    destroyStreams,
  };
}

async function waitForSubagentProcess(
  proc: ChildProcess,
  idleMs = 100,
  hardMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let exitCode: number | null = null;
    let exited = false;
    let settled = false;
    const cleanup = createProcessCleanup(proc, idleMs);
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup.clearIdleTimer();
      resolve(exitCode);
    };
    proc.on("close", done);
    proc.on("error", () => {
      exitCode = 1;
      exited = true;
      done();
    });
    proc.on("exit", (code) => {
      exitCode = code;
      exited = true;
      cleanup.armIdleTimer();
      const hardTimer = setTimeout(cleanup.destroyStreams, hardMs);
      hardTimer.unref?.();
    });
    const onStreamData = () => {
      if (exited) cleanup.armIdleTimer();
    };
    proc.stdout?.on("data", onStreamData);
    proc.stderr?.on("data", onStreamData);
  });
}

function setupAbortHandler(
  signal: AbortSignal | undefined,
  state: SubagentState,
  clearTimer: () => void,
  requestTermination: (reason: string) => Promise<unknown>,
): (() => void) | undefined {
  if (!signal) return undefined;
  const onAbort = () => {
    state.wasAborted = true;
    clearTimer();
    void requestTermination(getAbortReason(signal));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return onAbort;
}

async function finalizeResult(
  state: SubagentState,
  startedAt: number,
): Promise<RunSingleAgentResult> {
  state.result.durationMs = Date.now() - startedAt;
  clearGraceTimer(state);
  if (state.terminationPromise) await state.terminationPromise;
  if (state.spawnError) state.result.exitCode = 1;
  const outcome = getLatestOutcomeFromMessages(state.result.messages);
  const agentEndTimeoutExitCode = getAgentEndTimeoutExitCode(
    state.result,
    state.spawnError,
    outcome,
  );
  if (agentEndTimeoutExitCode !== undefined) {
    state.result.exitCode = agentEndTimeoutExitCode;
  }
  if (state.result.termination?.cancelReason === "agent_end_timeout") {
    state.result.stderr = state.result.stderr.replace(/^Terminated\r?\n/gm, "");
  }
  // Skip unresolved-error detection when complete succeeded: intermediate tool
  // errors (e.g. a linter exiting non-zero) are expected and already addressed.
  if (!outcome && detectMessageError(state.result.messages)) {
    state.result.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
  }
  if (state.wasAborted) {
    state.result.stderr = "";
    return { kind: "aborted", result: state.result };
  }
  const isSemanticallySuccessful =
    !state.spawnError &&
    state.result.exitCode === 0 &&
    (Boolean(outcome) ||
      (!state.result.errorMessage?.trim() &&
        !detectMessageError(state.result.messages)));
  if (isSemanticallySuccessful && outcome) {
    state.result.outcome = outcome;
  }
  return { kind: "completed", result: state.result };
}

/**
 * Rationale: Subagents run in isolated child processes to protect the parent's
 * context window and allow specialized system prompts/tools without polluting
 * the main conversation.
 *
 * Safety:
 * - Enforces a strict recursion limit (depth 2) via environment variables.
 * - Uses temporary prompt files to pass large system prompts without shell limits.
 * - Streams JSON events from the child to provide real-time UI updates to the parent.
 * - Implements aggressive process tree termination to prevent orphan processes.
 *
 * Side Effects: Spawns a child process and writes/deletes temporary files in `/tmp`.
 */
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (
    results: RuntimeResult[],
    options?: { includeMessages?: boolean; recentMessages?: Message[] },
  ) => SubagentDetails,
  parentModel: ChildModelSettings | undefined,
  parentThinking: ThinkingLevel,
  debugEventDiagnostics = false,
  options: RunSingleAgentOptions = {},
): Promise<RunSingleAgentResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent)
    return {
      kind: "completed",
      result: errorForUnknownAgent(agentName, agents, task),
    };
  const runtimeLimits = getSubagentRuntimeLimits();
  const depth = getSubagentDepth();
  if (depth >= runtimeLimits.maxDepth) {
    return {
      kind: "completed",
      result: errorForDepthLimit(
        agentName,
        agent.source,
        task,
        depth,
        runtimeLimits.maxDepth,
      ),
    };
  }
  const requestedThinking = agent.thinking ?? parentThinking;
  const effectiveModel = resolveEffectiveChildModelSettings(agent, parentModel);
  const resolvedThinking = resolveThinkingLevel(
    requestedThinking,
    effectiveModel.provider,
    effectiveModel.id,
    { registry: options.registry },
  );
  const thinking = resolvedThinking.level;
  const thinkingWarning = resolvedThinking.warning;
  if (resolvedThinking.diagnostic) console.warn(resolvedThinking.diagnostic);
  const modelDisplay = buildModelDisplay(effectiveModel, thinking);
  const resolvedSkillsPromise: Promise<{ args: string[] } | { error: string }> =
    agent.skills
      ? resolveAgentSkillArgs(defaultCwd, agent.skills)
      : Promise.resolve({ args: [] });
  const extensionNames =
    agent.extensions && agent.extensions.length > 0
      ? agent.extensions
      : undefined;
  const resolvedExtensionsPromise: Promise<
    { resolvedPaths: string[] } | { error: string }
  > = extensionNames
    ? resolveAgentExtensionPaths(defaultCwd, extensionNames)
    : Promise.resolve({ resolvedPaths: [] });
  const promptSetupPromise = beginPromptSetup(agent, options.role);
  const [resolvedSkills, resolvedExtensions, promptSetup] = await Promise.all([
    resolvedSkillsPromise,
    resolvedExtensionsPromise,
    promptSetupPromise,
  ]);
  const abortWithError = async (
    error: string,
  ): Promise<RunSingleAgentResult> => {
    await cleanupPromptSetupResult(promptSetup);
    return {
      kind: "completed",
      result: createErrorResult(
        agentName,
        agent.source,
        task,
        error,
        modelDisplay,
      ),
    };
  };
  if ("error" in resolvedSkills) return abortWithError(resolvedSkills.error);
  if ("error" in resolvedExtensions)
    return abortWithError(resolvedExtensions.error);
  if ("error" in promptSetup) {
    return {
      kind: "completed",
      result: createErrorResult(
        agentName,
        agent.source,
        task,
        `Failed to write prompt: ${
          promptSetup.error instanceof Error
            ? promptSetup.error.message
            : String(promptSetup.error)
        }`,
        modelDisplay,
      ),
    };
  }
  const startedAt = Date.now();
  const state: SubagentState = {
    result: initRuntimeResult(agentName, agent.source, task, modelDisplay),
    runtimeLimits,
    wasAborted: false,
  };
  if (thinkingWarning) state.result.thinkingWarning = thinkingWarning;
  if (options.role) state.result.role = roleMetadata(options.role);
  const tmpPrompt = promptSetup.tmpPrompt;
  const samplingEnv = buildSamplingEnv(agent);
  try {
    const args = buildPiArgs({
      agent,
      task,
      effectiveModel,
      // Intentionally the raw request, not `thinking`: resolveThinkingLevel's
      // clamp is only an estimate when the model isn't a confirmed live-registry
      // hit, and `pi` itself makes the authoritative call. `thinking`/`thinkingWarning`
      // still drive the user-facing display.
      thinking: requestedThinking,
      resolvedSkills,
      tmpPrompt,
      resolvedExtensionPaths:
        agent.extensions !== undefined
          ? resolvedExtensions.resolvedPaths
          : undefined,
      samplingEnv,
    });
    const invocation = getPiInvocation(args);
    const terminateOptions = {
      tree: true,
      platform: process.platform,
      processTreeDetached: process.platform !== "win32",
    };
    const childEnv = buildChildEnv(samplingEnv);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: invocation.command === "pi" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      ...getProcessTreeSpawnOptions(terminateOptions.tree),
    });
    const processDone = waitForSubagentProcess(proc);
    const emitUpdate = makeEmitUpdate(state.result, onUpdate, makeDetails);
    const requestTermination = makeRequestTerminator(
      proc,
      terminateOptions,
      state,
    );
    setupChildProcess(
      proc,
      state,
      emitUpdate,
      requestTermination,
      debugEventDiagnostics,
    );
    const onAbort = setupAbortHandler(
      signal,
      state,
      () => clearGraceTimer(state),
      requestTermination,
    );
    const orchestratorPid = getValidatedOrchestratorPid(options);
    const sleepInhibitorPromise =
      orchestratorPid !== undefined
        ? acquireSubagentSleepInhibitor(
            orchestratorPid,
            options.acquireSleepInhibitor ?? acquireDefaultSleepInhibitor,
          )
        : Promise.resolve(undefined);
    try {
      state.result.exitCode = (await processDone) ?? 0;
      return await finalizeResult(state, startedAt);
    } finally {
      clearGraceTimer(state);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      void startSleepInhibitorRelease(sleepInhibitorPromise);
    }
  } finally {
    if (tmpPrompt) await cleanupTempPrompt(tmpPrompt);
  }
}
