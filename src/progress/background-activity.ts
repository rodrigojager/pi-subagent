import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { listRunJobs } from "../orchestration/run-registry.js";
import type { SubagentTheme } from "../output/ui.js";
import {
  formatElapsed,
  renderToolActivityForDisplay,
} from "./progress-format.js";
import {
  getProgressState,
  type SubagentProgressState,
} from "./progress-state.js";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "./spinner.js";

const WIDGET_KEY = "subagent-activity";
const MAX_VISIBLE_JOBS = 3;
const ACTIVITY_CHANNEL = "rodrigojager:pi-subagent:activity:v1";

interface ActivityUpdate {
  context: ExtensionContext;
  states: SubagentProgressState[];
}

export function renderBackgroundActivity(
  states: readonly SubagentProgressState[],
  coordinatorRunning: boolean,
  width: number,
  now = Date.now(),
  theme?: Pick<SubagentTheme, "fg" | "bold">,
): string[] {
  const active = states.filter((state) => state.status === "running");
  if (active.length === 0) return [];
  const count = active.length;
  const coordinator = coordinatorRunning
    ? "coordenador trabalhando"
    : "coordenador aguardando";
  const fg: SubagentTheme["fg"] = (color, text) =>
    theme?.fg(color, text) ?? text;
  const lines = [
    fg("muted", `● Subagentes (${count} em execução) · ${coordinator}`),
  ];
  const visible = active.slice(0, MAX_VISIBLE_JOBS);
  for (const [index, state] of visible.entries()) {
    if (index > 0) lines.push(fg("muted", "│"));
    const branch =
      index === visible.length - 1 && count <= MAX_VISIBLE_JOBS ? "└─" : "├─";
    const indent = branch === "└─" ? "   " : "│  ";
    const name = fg("accent", theme?.bold(state.agent) ?? state.agent);
    const prefix = fg(
      "muted",
      `${branch} ${spinnerFrame(Math.max(0, now - state.startTime))} `,
    );
    const suffix = fg(
      "dim",
      ` ${state.instanceName ?? ""} · ${formatElapsed(Math.max(0, now - state.startTime))}`,
    );
    lines.push(`${prefix}${name}${suffix}`);
    lines.push(
      fg(
        "dim",
        `${indent} ${state.modelDisplay ?? "Modelo e thinking aguardando…"}`,
      ),
    );
    lines.push(
      `${fg("muted", `${indent} `)}${fg("toolOutput", state.taskPreview)}`,
    );
    const activity =
      state.health === "disconnected"
        ? "Conexão com mailbox perdida"
        : state.health === "suspected_stall"
          ? "Supervisor sem heartbeat"
          : state.jobHealth === "suspected_stall"
            ? "Sem progresso observado; possível travamento"
            : renderToolActivityForDisplay(
                state.activeToolActivity,
                Math.max(1, width - 4),
              );
    lines.push(
      fg(
        "muted",
        `${indent} → ${activity ?? "Aguardando resposta do modelo…"} · ${state.toolCount} tools`,
      ),
    );
  }
  if (count > MAX_VISIBLE_JOBS)
    lines.push(
      fg(
        "muted",
        `  +${count - MAX_VISIBLE_JOBS} em execução · /jobs para ver todos`,
      ),
    );
  return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

export class BackgroundActivityIndicator {
  private context: ExtensionContext | undefined;
  private sessionId: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tui: TUI | undefined;
  private coordinatorRunning = false;
  private visible = false;
  private states: SubagentProgressState[] = [];

  bind(ctx: ExtensionContext): void {
    this.dispose();
    this.context = ctx;
    this.sessionId = ctx.sessionManager?.getSessionId?.();
    this.coordinatorRunning = false;
    this.refresh(ctx);
  }

  setCoordinatorRunning(ctx: ExtensionContext, running: boolean): void {
    if (ctx.sessionManager?.getSessionId?.() !== this.sessionId) return;
    this.coordinatorRunning = running;
    this.refresh(ctx, this.states);
  }

  private activeStates(): SubagentProgressState[] {
    return this.states.filter((state) => state.status === "running");
  }

  refresh(ctx: ExtensionContext, states?: SubagentProgressState[]): void {
    if (!ctx.hasUI || !ctx.ui?.setWidget || !ctx.ui?.setStatus) return;
    // Tool callbacks can arrive before this controller receives session_start,
    // or through a separately loaded module after reload. Attach from the live
    // UI context instead of silently dropping the first background job.
    if (!this.context) {
      this.context = ctx;
      this.sessionId = ctx.sessionManager?.getSessionId?.();
      this.coordinatorRunning = ctx.isIdle?.() === false;
    }
    if (ctx.sessionManager?.getSessionId?.() !== this.sessionId) return;
    this.states =
      states ??
      listRunJobs()
        .filter((job) => job.sessionId === this.sessionId)
        .flatMap((job) => {
          const state = getProgressState(job.requestId);
          return state ? [state] : [];
        });
    if (this.activeStates().length === 0) {
      this.clear();
      return;
    }
    if (!this.visible) {
      this.visible = true;
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            invalidate() {},
            render: (width) =>
              renderBackgroundActivity(
                this.activeStates(),
                this.coordinatorRunning,
                width,
                Date.now(),
                theme,
              ),
          };
        },
        { placement: "aboveEditor" },
      );
    }
    // Updating the persistent status requests a TUI render, including the widget.
    ctx.ui.setStatus(
      WIDGET_KEY,
      `${spinnerFrame()} ${renderBackgroundActivity(this.activeStates(), this.coordinatorRunning, 100)[0] ?? ""}`,
    );
    this.tui?.requestRender();
    this.timer ??= setInterval(() => {
      if (this.context) {
        this.coordinatorRunning = this.context.isIdle?.() === false;
        this.refresh(this.context, this.states);
      }
    }, SPINNER_INTERVAL_MS);
    this.timer.unref?.();
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.visible) {
      this.context?.ui?.setWidget?.(WIDGET_KEY, undefined);
      this.context?.ui?.setStatus?.(WIDGET_KEY, undefined);
    }
    this.visible = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.clear();
    this.context = undefined;
    this.sessionId = undefined;
    this.states = [];
  }
}

let indicator: BackgroundActivityIndicator | undefined;

export function refreshBackgroundActivity(
  ctx: ExtensionContext,
  pi?: ExtensionAPI,
  states?: SubagentProgressState[],
): void {
  // Publish the lifecycle's own snapshot through the host bus. The controller
  // and a reloaded tool can belong to different evaluated module instances.
  // Sharing the host bus avoids relying on their module-local singleton identity.
  if (pi?.events && states) {
    pi.events.emit(ACTIVITY_CHANNEL, {
      context: ctx,
      states,
    } satisfies ActivityUpdate);
    return;
  }
  indicator ??= new BackgroundActivityIndicator();
  indicator.refresh(ctx, states);
}

export function registerBackgroundActivity(pi: ExtensionAPI): void {
  indicator?.dispose();
  const current = new BackgroundActivityIndicator();
  indicator = current;
  pi.events?.on(ACTIVITY_CHANNEL, (data) => {
    const update = data as ActivityUpdate;
    current.refresh(update.context, update.states);
  });
  pi.on("session_start", (_event, ctx) => current.bind(ctx));
  pi.on("agent_start", (_event, ctx) =>
    current.setCoordinatorRunning(ctx, true),
  );
  pi.on("agent_end", (_event, ctx) =>
    current.setCoordinatorRunning(ctx, false),
  );
  pi.on("session_shutdown", () => current.dispose());
}
