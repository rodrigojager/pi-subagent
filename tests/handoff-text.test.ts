import { expect, test } from "bun:test";
import { buildPiArgs } from "../src/child/pi-args.js";
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
