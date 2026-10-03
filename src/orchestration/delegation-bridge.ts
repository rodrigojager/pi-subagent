import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { startSubagentJob } from "./subagent-orchestrator.js";

/** Public, synchronous capability handshake; execution stays in the normal /run lifecycle. */
export const DELEGATION_CHANNEL = "rodrigojager:pi-subagent:delegate:v1";
interface Reply {
  ok: boolean;
  message: string;
}
interface Request {
  agent: string;
  task: string;
  context: ExtensionContext;
  accept: (run: () => Promise<Reply>) => void;
}
function isRequest(data: unknown): data is Request {
  if (!data || typeof data !== "object") return false;
  const request = data as Partial<Request>;
  return (
    typeof request.agent === "string" &&
    request.agent.trim().length > 0 &&
    typeof request.task === "string" &&
    request.task.trim().length > 0 &&
    typeof request.context?.cwd === "string" &&
    typeof request.accept === "function"
  );
}
export function registerDelegationBridge(
  pi: ExtensionAPI,
  start = startSubagentJob,
): void {
  // Older embedders and test hosts can omit the optional cross-extension bus.
  if (!pi.events) return;
  pi.events.on(DELEGATION_CHANNEL, (data) => {
    if (!isRequest(data)) return;
    data.accept(async () => {
      try {
        const result = await start(
          pi,
          data.context,
          { agent: data.agent, task: data.task },
          data.context.signal,
        );
        if (result.kind === "not_found")
          return { ok: false, message: `Unknown subagent: ${data.agent}` };
        if (result.kind === "cancelled")
          return { ok: false, message: "Delegation cancelled" };
        if (result.kind === "completed")
          return { ok: true, message: `Subagent ${data.agent} finished` };
        return {
          ok: true,
          message: `Subagent ${data.agent} ${result.instanceName} started (job: ${result.requestId})`,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  });
}
