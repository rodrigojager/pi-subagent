import type { RoleMetadata } from "../roles/types.js";

export type RunJob = {
  sessionId?: string | undefined;
  role?: RoleMetadata | undefined;
  requestId: string;
  agentName: string;
  instanceName: string;
  controller: AbortController;
  startedAt: number;
  cancelReason?: string;
};

const jobs = new Map<string, RunJob>();

export function registerRunJob(job: RunJob): RunJob {
  jobs.set(job.requestId, job);
  return job;
}

export function getRunJob(requestId: string): Readonly<RunJob> | undefined {
  return jobs.get(requestId);
}

export function listRunJobs(): readonly Readonly<RunJob>[] {
  return [...jobs.values()];
}

export function removeRunJob(requestId: string): boolean {
  return jobs.delete(requestId);
}

function abortRunJob(job: RunJob, reason: string): void {
  if (job.controller.signal.aborted) return;
  job.cancelReason = reason;
  job.controller.abort(new Error(reason));
}

export function cancelRunJob(requestId: string, reason = "Cancelled"): boolean {
  const job = jobs.get(requestId);
  if (!job) return false;
  abortRunJob(job, reason);
  return true;
}

export function cancelAllRunJobs(reason = "Cancelled"): number {
  let count = 0;
  for (const job of jobs.values()) {
    abortRunJob(job, reason);
    count += 1;
  }
  return count;
}

export function resetRunRegistry(): void {
  jobs.clear();
}
