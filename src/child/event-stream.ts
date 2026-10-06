/**
 * Wires a spawned child `pi` process to subagent state: parses its JSON
 * event stream, captures `stderr`, and routes termination requests.
 */

import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Message } from "@earendil-works/pi-ai";
import type { getSubagentRuntimeLimits } from "../shared/utils.js";
import {
  type ChildEventParseResult,
  type ChildKnownEvent,
  parseChildEventLine,
  TOOL_EXECUTION_UPDATE_EVENT,
} from "./child-events.js";
import { appendWithByteLimit } from "./process-utils.js";
import {
  addMessageToResult,
  type RuntimeResult,
  rebuildResultFromMessages,
} from "./result-builder.js";
import type { EmitUpdateFn } from "./streaming-progress.js";
import { terminateChildProcess } from "./termination.js";

type RuntimeLimits = ReturnType<typeof getSubagentRuntimeLimits>;

export interface SubagentState {
  result: RuntimeResult;
  runtimeLimits: RuntimeLimits;
  spawnError?: Error;
  observedChildSignal?: NodeJS.Signals | undefined;
  wasAborted: boolean;
  agentEndGraceTimer?: ReturnType<typeof setTimeout>;
  terminationPromise?: Promise<unknown>;
}

export function makeRequestTerminator(
  proc: ChildProcess,
  terminateOptions: {
    tree: boolean;
    platform: NodeJS.Platform;
    processTreeDetached: boolean;
  },
  state: SubagentState,
): (reason: string) => Promise<unknown> {
  return (reason: string) => {
    state.terminationPromise ??= terminateChildProcess(proc, {
      ...terminateOptions,
      reason,
    }).then((metadata) => {
      state.result.termination = metadata;
    });
    return state.terminationPromise;
  };
}

export function clearGraceTimer(state: SubagentState): void {
  if (!state.agentEndGraceTimer) return;
  clearTimeout(state.agentEndGraceTimer);
  delete state.agentEndGraceTimer;
}

function handleMessageEvent(
  event: ChildKnownEvent,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
): void {
  if (event.type !== "message_end" && event.type !== "tool_result_end") return;
  if (event.message) {
    addMessageToResult(state.result, event.message as Message);
    const toolResultCompleted = event.type === "tool_result_end";
    emitUpdate({ toolResultCompleted });
  }
}

function handleToolExecutionUpdateEvent(
  event: ChildKnownEvent,
  emitUpdate: EmitUpdateFn,
): void {
  if (event.type !== TOOL_EXECUTION_UPDATE_EVENT) return;
  emitUpdate({ toolActivity: event.toolActivity });
}

function handleAgentEndEvent(
  event: ChildKnownEvent,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
  requestTermination: (reason: string) => Promise<unknown>,
): void {
  if (event.type !== "agent_end") return;
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    rebuildResultFromMessages(state.result, event.messages as Message[]);
    emitUpdate();
  }
  if (state.agentEndGraceTimer || state.terminationPromise) return;
  state.agentEndGraceTimer = setTimeout(() => {
    delete state.agentEndGraceTimer;
    void requestTermination("agent_end_timeout");
  }, state.runtimeLimits.agentEndGraceMs);
  state.agentEndGraceTimer.unref?.();
}

function formatUnknownEventDiagnostic(
  line: string,
  parseResult: Exclude<ChildEventParseResult, { kind: "known" }>,
): string {
  if (parseResult.kind === "invalid" && !line.trim()) {
    return "[pi-subagent:unknown-event] blank";
  }
  if (parseResult.kind === "invalid") {
    return `[pi-subagent:unknown-event] malformed: ${line}`;
  }
  return `[pi-subagent:unknown-event] unknown: ${JSON.stringify(parseResult.event)}`;
}

function processEventLine(
  line: string,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
  requestTermination: (reason: string) => Promise<unknown>,
  debugEventDiagnostics: boolean,
): void {
  const parseResult = parseChildEventLine(line);
  if (parseResult.kind !== "known") {
    if (debugEventDiagnostics) {
      process.stderr.write(
        `${formatUnknownEventDiagnostic(line, parseResult)}\n`,
      );
    }
    return;
  }
  const { event } = parseResult;
  handleMessageEvent(event, state, emitUpdate);
  handleToolExecutionUpdateEvent(event, emitUpdate);
  handleAgentEndEvent(event, state, emitUpdate, requestTermination);
}

export function setupChildProcess(
  proc: ChildProcess,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
  requestTermination: (reason: string) => Promise<unknown>,
  debugEventDiagnostics: boolean,
): void {
  proc.once("error", (error) => {
    state.spawnError = error;
    state.result.stderr = appendWithByteLimit(
      state.result.stderr,
      error.message,
      state.runtimeLimits.maxStderrBytes,
    );
  });
  if (proc.stdout) {
    readline
      .createInterface({ input: proc.stdout })
      .on("line", (line) =>
        processEventLine(
          line,
          state,
          emitUpdate,
          requestTermination,
          debugEventDiagnostics,
        ),
      );
  }
  if (proc.stderr) {
    proc.stderr.on("data", (data: Buffer) => {
      state.result.stderr = appendWithByteLimit(
        state.result.stderr,
        data,
        state.runtimeLimits.maxStderrBytes,
      );
    });
  }
}
