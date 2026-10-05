import { expect, test } from "bun:test";
import { renderRunsBoard, type SubagentTheme } from "../src/output/ui.js";
import {
  clearProgressState,
  createProgressState,
  finalizeProgressState,
  getProgressState,
  markUnknownProgressState,
  patchProgressState,
} from "../src/progress/progress-state.js";

const theme: SubagentTheme = {
  fg: (_color, value) => value,
  bg: (_color, value) => value,
  bold: (value) => value,
};

function requiredState(id: string) {
  const state = getProgressState(id);
  if (!state) throw new Error(`Missing progress state ${id}`);
  return state;
}

test("lost supervision is indeterminate in the jobs board and a late artifact can reconcile it", () => {
  const id = "mailbox-unknown-fixture";
  createProgressState(id, "executor", "Long-running task");
  try {
    patchProgressState(id, { health: "disconnected" });
    const disconnected = renderRunsBoard([requiredState(id)], theme, 100)
      .render(100)
      .join("\n");
    expect(disconnected).toContain("Mailbox connection lost");

    patchProgressState(id, {
      health: "responsive",
      jobHealth: "suspected_stall",
    });
    const quiet = renderRunsBoard([requiredState(id)], theme, 100)
      .render(100)
      .join("\n");
    expect(quiet).toContain("No subagent activity observed");

    markUnknownProgressState(id, "Supervisor lost; result indeterminate");
    expect(getProgressState(id)?.status).toBe("unknown");
    const unknown = renderRunsBoard([requiredState(id)], theme, 100)
      .render(100)
      .join("\n");
    expect(unknown).toContain("INDETERMINATE (1)");
    expect(unknown).toContain("result indeterminate");

    finalizeProgressState(id, "Completed after recovery");
    expect(getProgressState(id)?.status).toBe("success");
    const recovered = renderRunsBoard([requiredState(id)], theme, 100)
      .render(100)
      .join("\n");
    expect(recovered).toContain("SUCCEEDED (1)");
  } finally {
    clearProgressState(id);
  }
});
