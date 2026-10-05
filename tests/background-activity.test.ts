import { afterEach, expect, spyOn, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  registerRunJob,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  BackgroundActivityIndicator,
  refreshBackgroundActivity,
  registerBackgroundActivity,
  renderBackgroundActivity,
} from "../src/progress/background-activity.js";
import { renderSubagentProgress } from "../src/progress/progress.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  patchProgressState,
  resetProgressStore,
  type SubagentProgressState,
} from "../src/progress/progress-state.js";

const indicators: BackgroundActivityIndicator[] = [];
afterEach(() => {
  for (const indicator of indicators.splice(0)) indicator.dispose();
  resetRunRegistry();
  resetProgressStore();
});

function state(index = 1): SubagentProgressState {
  return {
    requestId: `job-${index}`,
    agent: "ova-luna-implement",
    instanceName: `#${index}`,
    taskPreview: `F05-CLOSE-E2E-${index}`,
    modelDisplay: "openai-codex ･ gpt-6-luna ･ high",
    status: "running",
    startTime: 0,
    toolCount: 4,
    activeToolActivity: { toolName: "bash", inputSummary: "ninja -j2" },
  };
}

function uiContext(sessionId = "session-a", hasUI = true) {
  const statuses: (string | undefined)[] = [];
  const widgets: unknown[] = [];
  const ctx = {
    hasUI,
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus: (_key: string, text: string | undefined) =>
        statuses.push(text),
      setWidget: (_key: string, content: unknown) => widgets.push(content),
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses, widgets };
}

function startJob(id = "job-1", sessionId = "session-a") {
  registerRunJob({
    requestId: id,
    sessionId,
    agentName: "ova-luna-implement",
    instanceName: "#1",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  createProgressState(id, "ova-luna-implement", "F05-CLOSE-E2E-02", "#1");
  patchProgressState(id, {
    activeToolActivity: { toolName: "bash", inputSummary: "ninja -j2" },
  });
}

test("spinner changes while coordinator waits; task, activity and duration remain visible", () => {
  const first = renderBackgroundActivity([state()], false, 140, 0);
  const second = renderBackgroundActivity([state()], false, 140, 125);
  expect(first[1]).not.toBe(second[1]);
  expect(first[1]).toContain("└─ ⠋ ova-luna-implement #1");
  expect(first.join("\n")).toContain("coordenador aguardando");
  expect(first.join("\n")).toContain("F05-CLOSE-E2E-1");
  expect(first.join("\n")).toContain("ninja -j2");
  expect(first.join("\n")).toContain("0.0s");
  expect(first[2]).toContain("openai-codex ･ gpt-6-luna ･ high");
  expect(renderBackgroundActivity([state()], true, 140, 0)[0]).toContain(
    "coordenador trabalhando",
  );
  const colors: { color: string; text: string }[] = [];
  const themed = renderBackgroundActivity([state()], false, 140, 0, {
    fg: (color, text) => {
      colors.push({ color, text });
      return text;
    },
    bold: (text) => text,
  });
  expect(
    colors.filter(({ color }) => color === "accent").map(({ text }) => text),
  ).toEqual(["ova-luna-implement"]);
  expect(colors.find(({ text }) => text === "F05-CLOSE-E2E-1")?.color).toBe(
    "toolOutput",
  );
  expect(themed[2]).toContain("gpt-6-luna ･ high");
});

test("multiple jobs keep exact count and bound the visible list", () => {
  const lines = renderBackgroundActivity(
    [1, 2, 3, 4, 5].map(state),
    false,
    140,
    1000,
  );
  expect(lines[0]).toContain("Subagentes (5 em execução)");
  expect(lines).toHaveLength(16);
  expect(lines.filter((line) => line === "│")).toHaveLength(2);
  expect(lines.at(-1)).toContain("+2 em execução");
  expect(lines.join("\n")).not.toContain("#4");
});

test("narrow layouts fit; terminal jobs disappear; activity redaction is preserved", () => {
  const sensitive = {
    ...state(),
    activeToolActivity: { toolName: "bash", inputSummary: "password=example" },
  };
  expect(
    renderBackgroundActivity([sensitive], false, 140, 0).join("\n"),
  ).not.toContain("password=example");
  for (const width of [1, 8, 35, 80]) {
    for (const line of renderBackgroundActivity([state()], false, width, 0))
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  expect(
    renderBackgroundActivity([{ ...state(), status: "success" }], false, 80),
  ).toEqual([]);
});

test("live widget survives parent turn end, animates, and stops when disposed", async () => {
  const ui = uiContext();
  const indicator = new BackgroundActivityIndicator();
  indicators.push(indicator);
  indicator.bind(ui.ctx);
  startJob();
  indicator.refresh(ui.ctx);
  indicator.setCoordinatorRunning(ui.ctx, true);
  indicator.setCoordinatorRunning(ui.ctx, false);
  expect(ui.statuses.at(-1)).toContain("coordenador aguardando");
  expect(ui.widgets).toHaveLength(1);
  const before = ui.statuses.length;
  await Bun.sleep(180);
  expect(ui.statuses.length).toBeGreaterThan(before);
  indicator.dispose();
  expect(ui.widgets.at(-1)).toBeUndefined();
  expect(ui.statuses.at(-1)).toBeUndefined();
  const stopped = ui.statuses.length;
  await Bun.sleep(160);
  expect(ui.statuses).toHaveLength(stopped);
});

test.each(["success", "error", "cancelled"])(
  "%s clears the persistent indicator",
  (outcome) => {
    const ui = uiContext();
    const indicator = new BackgroundActivityIndicator();
    indicators.push(indicator);
    indicator.bind(ui.ctx);
    startJob();
    indicator.refresh(ui.ctx);
    if (outcome === "success")
      finalizeProgressState("job-1", "Build completed");
    else if (outcome === "error") failProgressState("job-1", "Build failed");
    else cancelProgressState("job-1", "User cancelled task");
    indicator.refresh(ui.ctx);
    expect(ui.statuses.at(-1)).toBeUndefined();
    expect(ui.widgets.at(-1)).toBeUndefined();
  },
);

test("switching session hides old jobs and stale callbacks cannot resurrect them", () => {
  const oldUi = uiContext();
  const newUi = uiContext("session-b");
  const indicator = new BackgroundActivityIndicator();
  indicators.push(indicator);
  indicator.bind(oldUi.ctx);
  startJob();
  indicator.refresh(oldUi.ctx);
  indicator.bind(newUi.ctx);
  indicator.refresh(oldUi.ctx);
  expect(oldUi.statuses.at(-1)).toBeUndefined();
  expect(newUi.widgets).toHaveLength(0);
  startJob("job-2", "session-b");
  indicator.refresh(newUi.ctx);
  expect(newUi.statuses.at(-1)).toContain("Subagentes (1 em execução)");
});

test("headless contexts do not create widgets or animation timers", () => {
  const ui = uiContext("session-a", false);
  const indicator = new BackgroundActivityIndicator();
  indicators.push(indicator);
  startJob();
  indicator.bind(ui.ctx);
  expect(ui.widgets).toHaveLength(0);
  expect(ui.statuses).toHaveLength(0);
});

test("first tool update attaches the panel even without an earlier session_start", () => {
  const ui = uiContext();
  const indicator = new BackgroundActivityIndicator();
  indicators.push(indicator);
  startJob();
  indicator.refresh(ui.ctx);
  expect(ui.widgets).toHaveLength(1);
  expect(ui.statuses.at(-1)).toContain("Subagentes (1 em execução)");
});

test("host bus delivers the lifecycle snapshot even without shared module-local stores", () => {
  const listeners = new Map<string, (data: unknown) => void>();
  const hooks = new Map<
    string,
    (_event: unknown, ctx: ExtensionContext) => void
  >();
  const pi = {
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
      emit: (name: string, data: unknown) => listeners.get(name)?.(data),
    },
    on: (
      name: string,
      handler: (_event: unknown, ctx: ExtensionContext) => void,
    ) => hooks.set(name, handler),
  } as unknown as ExtensionAPI;
  const ui = uiContext();
  registerBackgroundActivity(pi);
  // Deliberately do not register any job in the controller's local registry.
  refreshBackgroundActivity(ui.ctx, pi, [state()]);
  expect(ui.widgets).toHaveLength(1);
  expect(ui.statuses.at(-1)).toContain("Subagentes (1 em execução)");
  hooks.get("agent_end")?.({}, ui.ctx);
  expect(ui.statuses.at(-1)).toContain("coordenador aguardando");
  refreshBackgroundActivity(ui.ctx, pi, []);
  expect(ui.widgets.at(-1)).toBeUndefined();
  hooks.get("session_shutdown")?.({}, ui.ctx);
});

test("historical progress card animates its running glyph", () => {
  createProgressState("card", "ova-luna-implement", "F05", "#7");
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
  };
  const card = renderSubagentProgress(
    { details: { requestId: "card" } },
    { expanded: false },
    theme,
  );
  const clock = spyOn(Date, "now").mockReturnValue(0);
  try {
    const first = card?.render(120).join("\n");
    clock.mockReturnValue(125);
    expect(card?.render(120).join("\n")).not.toBe(first);
  } finally {
    clock.mockRestore();
  }
});
