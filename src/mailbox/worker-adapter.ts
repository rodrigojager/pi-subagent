import type { AgentConfig, ThinkingLevel } from "../agent/agents.js";
import type { ChildModelSettings } from "../child/model-resolution.js";
import { runSingleAgent } from "../child/process.js";
import {
  formatSubagentFailureForParent,
  formatSubagentResultForParent,
} from "../output/summary.js";
import {
  createSubagentError,
  sanitizeResultDetails,
} from "../progress/result-details.js";
import type { RoleResolution } from "../roles/types.js";
import type { SingleResult, SubagentDetails } from "../shared/types.js";
import {
  extractFinalOutputFromMessages,
  hasSubagentFailed,
} from "../shared/utils.js";

export interface MailboxWorkerJob {
  jobId: string;
  instanceName: string;
  cwd: string;
  agent: AgentConfig;
  task: string;
  role: RoleResolution;
  agentScope: "user" | "project" | "both";
  projectAgentsDir: string | null;
  parentModel?: ChildModelSettings | undefined;
  parentThinking: ThinkingLevel;
  debug: boolean;
  depth: number;
  piInvocation: { command: string; args: string[] };
}

export interface MailboxWorkerOutcome {
  state: "succeeded" | "failed" | "cancelled";
  summary: string;
  details: SubagentDetails;
}

/** Runs only in the mailbox-owned worker. The Pi UI process prepares and authorizes the job. */
export async function runMailboxJob(
  job: MailboxWorkerJob,
  onProgress: (details: SubagentDetails) => void,
  signal: AbortSignal,
): Promise<MailboxWorkerOutcome> {
  const makeDetails = (results: SingleResult[]): SubagentDetails => ({
    mode: "single",
    agentScope: job.agentScope,
    projectAgentsDir: job.projectAgentsDir,
    results: results.map((result) =>
      sanitizeResultDetails(
        { ...result, instanceName: job.instanceName },
        job.debug,
        undefined,
      ),
    ),
  });
  const outcome = await runSingleAgent(
    job.cwd,
    [job.agent],
    job.agent.name,
    job.task,
    signal,
    (update) => onProgress(makeDetails(update.details.results)),
    makeDetails,
    job.parentModel,
    job.parentThinking,
    job.debug,
    { role: job.role, piInvocation: job.piInvocation },
  );
  const result = outcome.result;
  const details = makeDetails([result]);
  if (outcome.kind === "aborted") {
    return { state: "cancelled", summary: "Canceled", details };
  }
  const hasFinalOutput = Boolean(
    result.finalOutput.trim() ||
      result.outcome?.trim() ||
      extractFinalOutputFromMessages(result.messages ?? []).trim(),
  );
  if (hasSubagentFailed(result) || !hasFinalOutput) {
    const reason = hasSubagentFailed(result)
      ? createSubagentError(result).message
      : "Subagent exited without a final result";
    return {
      state: "failed",
      summary: formatSubagentFailureForParent(reason, result),
      details,
    };
  }
  return {
    state: "succeeded",
    summary: formatSubagentResultForParent(result) || "(no output)",
    details,
  };
}
