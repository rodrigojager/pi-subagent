import { expect, test } from "bun:test";
import { buildPiArgs } from "../src/child/pi-args.js";
import { formatHandoffTask } from "../src/orchestration/handoff-task.js";
import { makeTaskPreview } from "../src/progress/progress-state.js";
import { hangAgent } from "./helpers.js";

test("handoff text preserves word boundaries, Unicode and literal identifiers in child arguments", () => {
  const task =
    "Corrigir BUG CONCRETO pointer observação.\nBase b1777b3; worktree D:/SpyBrowser-work/resume-pointer-observation.\nPreservar PageInputSession e plan §7.3/7.5.";
  const args = buildPiArgs({
    agent: hangAgent,
    task,
    effectiveModel: {},
    thinking: "off",
    resolvedSkills: { args: [] },
    tmpPrompt: null,
  });
  expect(args.at(-1)).toBe(`Task: ${task}`);
  const preview = makeTaskPreview(task);
  expect(preview).toContain("BUG CONCRETO pointer observação");
  expect(preview).toContain("Base b1777b3");
  expect(preview).toContain("PageInputSession");
  expect(task).toContain("\n");
});

test("ticket handoff produces a readable child prompt and activity preview without restating the ticket", () => {
  const ticketPath = "D:/SpyBrowser/docs/tickets/05-pointer-observation.md";
  const worktreePath = "D:/SpyBrowser-work/resume-pointer-observation";
  const task = formatHandoffTask({ ticketPath, worktreePath });
  const args = buildPiArgs({
    agent: hangAgent,
    task,
    effectiveModel: {},
    thinking: "off",
    resolvedSkills: { args: [] },
    tmpPrompt: null,
  });
  expect(task).toBe(
    `Worktree: ${worktreePath}\nUse this worktree for edits and tests.\nRead the full ticket at ${ticketPath} before editing. Implement its acceptance criteria.`,
  );
  expect(args.at(-1)).toBe(`Task: ${task}`);
  expect(makeTaskPreview(task)).toContain(
    `Worktree: ${worktreePath} Use this worktree for edits and tests. Read the full ticket at ${ticketPath}`,
  );
});

test("ticket handoff keeps supplemental instructions and freeform tasks intact", () => {
  expect(formatHandoffTask({ task: "BUG CONCRETO pointer observação" })).toBe(
    "BUG CONCRETO pointer observação",
  );
  expect(
    formatHandoffTask({
      ticketPath: "D:/tickets/05.md",
      task: "Preserve o identificador PointerObservation.",
    }),
  ).toBe(
    "Read the full ticket at D:/tickets/05.md before editing. Implement its acceptance criteria.\nSupplemental instructions: Preserve o identificador PointerObservation.",
  );
  expect(() => formatHandoffTask({ ticketPath: " " })).toThrow(
    "ticketPath must not be blank",
  );
});
