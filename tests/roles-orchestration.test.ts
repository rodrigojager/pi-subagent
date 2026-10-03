import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCachedAgentDiscovery } from "../src/agent/agent-cache.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import { renderRunsBoard, renderSubagentResult } from "../src/output/ui.js";
import { getAllProgressStates } from "../src/progress/progress-state.js";
import {
  createDefaultFakeTheme as makeTheme,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();
test("nested same-agent tool invocations capture distinct roles, preserve completion contract, cards and defaults", async () => {
  const { cwd, agentDir, tool } = await setupTest({
    piScript: `#!/bin/sh
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --append-system-prompt|--system-prompt) shift; if [ -f "$1" ]; then prompt="$(cat "$1")"; else prompt="$prompt\n$1"; fi ;;
    'Task: '*) label="$(printf '%s' "$1" | cut -c7-)" ;;
  esac
  shift
done
printf '%s' "$prompt" > "$label.prompt"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"complete-1","name":"complete","arguments":{"outcome":"Roles validated"}}],"api":"fake","provider":"fake","model":"fake","stopReason":"toolUse","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}},"timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
`,
  });
  const roles = path.join(agentDir, "roles");
  await mkdir(roles);
  await writeFile(path.join(roles, "backend-architect.md"), "ARCHITECT_ROLE");
  await writeFile(path.join(roles, "code-reviewer.md"), "REVIEWER_ROLE");
  await writeFile(
    path.join(agentDir, "agents/executor.md"),
    "---\nname: executor\ndescription: Role fixture\nrole: backend-architect\nskills: false\ncontext: false\nextensions: false\nreplace_prompt: true\n---\nEXECUTOR_BODY",
  );
  process.env.PI_SUBAGENT_DEPTH = "1";
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const requests = [
    { task: "default" },
    { task: "none", role: "none" },
    { task: "reviewer", role: "code-reviewer" },
  ];
  const results = await Promise.all(
    requests.map((request, i) =>
      tool.execute(
        `call-${i}`,
        { agent: "executor", ...request },
        undefined,
        undefined,
        ctx,
      ),
    ),
  );
  for (const [i, request] of requests.entries()) {
    const prompt = await readFile(
      path.join(cwd, `${request.task}.prompt`),
      "utf8",
    );
    expect(prompt).toContain("EXECUTOR_BODY");
    expect(prompt).toContain(SUBAGENT_RESULT_CONTRACT);
    expect(prompt.split("ARCHITECT_ROLE").length - 1).toBe(i === 0 ? 1 : 0);
    expect(prompt.split("REVIEWER_ROLE").length - 1).toBe(i === 2 ? 1 : 0);
    const result = results[i]?.details?.results[0];
    expect(result?.outcome).toBe("Roles validated");
    expect(result?.role?.effectiveId).toBe(
      i === 0 ? "backend-architect" : i === 2 ? "code-reviewer" : undefined,
    );
    expect(result?.role).not.toHaveProperty("body");
    const rendered = renderSubagentResult(
      results[i] ?? { content: [] },
      makeTheme(),
    )
      .render(80)
      .join("\n");
    expect(rendered).toContain(
      i === 1
        ? "Role: None"
        : i === 0
          ? "Role: Backend Architect (default)"
          : "Role: Code Reviewer (override)",
    );
  }
  const board = renderRunsBoard(getAllProgressStates(), makeTheme(), 80)
    .render(80)
    .join("\n");
  expect(board).toContain("Role: Code Reviewer (override)");
  expect(board).toContain("Role: None");
  const fresh = await tool.execute(
    "fresh",
    { agent: "executor", task: "fresh" },
    undefined,
    undefined,
    ctx,
  );
  expect(fresh.details?.results[0]?.role?.effectiveId).toBe(
    "backend-architect",
  );
  const cached = await getCachedAgentDiscovery(cwd, "both");
  const agent = cached.agents.find((a) => a.name === "executor");
  expect(agent?.role).toBe("backend-architect");
  expect(agent?.systemPrompt).toBe("EXECUTOR_BODY");
});
