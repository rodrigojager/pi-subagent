import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { importAgencyRoles } from "../scripts/import-agency-roles.js";
import type { AgentConfig } from "../src/agent/agents.js";
import { buildPiArgs } from "../src/child/pi-args.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import {
  beginPromptSetup,
  cleanupPromptSetupResult,
} from "../src/child/prompt-setup.js";
import {
  discoverRoles,
  isRoleId,
  normalizeRoleRequest,
  parseRoleDocument,
  parseRolePrefix,
  resolveRole,
  roleMetadata,
} from "../src/roles/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-roles-"));
  roots.push(root);
  const agentDir = path.join(root, "user");
  const cwd = path.join(root, "project", "nested");
  await mkdir(cwd, { recursive: true });
  const put = async (relative: string, text: string) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };
  return { root, agentDir, cwd, put };
}
test.each([
  "default",
  "none",
  "../foo",
  "A",
  "a/b",
  "a\\b",
  "C:foo",
  "a\u0000",
  "a..b",
  "con",
  "/foo",
])("rejects nonportable file ID %s", (id) => expect(isRoleId(id)).toBe(false));
test("optional metadata does not configure capabilities and only body enters resolution", () => {
  const role = parseRoleDocument(
    "---\nname: Architect\nmodel: invented\ntools: all\n---\nARCHITECT_ROLE",
    "backend-architect.md",
    "user",
  );
  expect(role.body).toBe("ARCHITECT_ROLE");
  expect(role).not.toHaveProperty("model");
  expect(() =>
    parseRoleDocument(
      "---\nid: wrong\n---\nbody",
      "backend-architect.md",
      "user",
    ),
  ).toThrow();
  expect(() =>
    parseRoleDocument("---\nname: unfinished", "backend-architect.md", "user"),
  ).toThrow();
  expect(() =>
    parseRoleDocument(
      "---\nname: [\n---\nbody",
      "backend-architect.md",
      "user",
    ),
  ).toThrow();
  expect(() =>
    parseRoleDocument(" ", "backend-architect.md", "user"),
  ).toThrow();
});
test("project scope, malformed shadow, ambiguous IDs, nearest roles root and trust are independent of agent scope", async () => {
  const f = await fixture();
  await f.put("user/roles/engineering/backend-architect.md", "GLOBAL");
  await f.put("project/.pi/roles/backend-architect.md", "PROJECT");
  await f.put("project/.pi/agents/unused.md", "unused");
  await f.put("user/roles/a/code-reviewer.md", "A");
  await f.put("user/roles/b/code-reviewer.md", "B");
  let catalog = await discoverRoles({ ...f, allowProject: true });
  expect(resolveRole(catalog, "backend-architect").body).toBe("PROJECT");
  expect(resolveRole(catalog, "code-reviewer").status).toBe("invalid");
  await f.put(
    "project/.pi/roles/backend-architect.md",
    "---\nid: mismatched\n---\nBAD",
  );
  catalog = await discoverRoles({ ...f, allowProject: true });
  expect(resolveRole(catalog, "backend-architect").status).toBe("invalid");
  expect(
    resolveRole(
      await discoverRoles({ ...f, allowProject: false }),
      "backend-architect",
    ).body,
  ).toBe("GLOBAL");
  expect(catalog.diagnostics.length).toBeGreaterThan(0);
});
test("resolution table, snapshots, file refresh and explicit missing override never fall back", async () => {
  const f = await fixture();
  await f.put("user/roles/backend-architect.md", "ARCHITECT_ROLE");
  await f.put("user/roles/code-reviewer.md", "REVIEWER_ROLE");
  const catalog = await discoverRoles(f);
  for (const input of [undefined, "default"])
    expect(resolveRole(catalog, "backend-architect", input).effectiveId).toBe(
      "backend-architect",
    );
  expect(resolveRole(catalog, "backend-architect", "none").status).toBe("none");
  expect(resolveRole(catalog, undefined, "code-reviewer").effectiveId).toBe(
    "code-reviewer",
  );
  expect(resolveRole(catalog, undefined).status).toBe("none");
  expect(resolveRole(catalog, "absent").status).toBe("missing");
  expect(
    resolveRole(catalog, "backend-architect", "absent").body,
  ).toBeUndefined();
  expect(() => normalizeRoleRequest(null)).toThrow();
  expect(() => normalizeRoleRequest(2)).toThrow();
  const snapshot = resolveRole(catalog, "backend-architect");
  await f.put("user/roles/backend-architect.md", "CHANGED");
  expect(snapshot.body).toBe("ARCHITECT_ROLE");
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.requested)).toBe(true);
  expect(roleMetadata(snapshot)).not.toHaveProperty("body");
  expect(roleMetadata(snapshot)).not.toHaveProperty("sourcePath");
  expect(resolveRole(await discoverRoles(f), "backend-architect").body).toBe(
    "CHANGED",
  );
  await rm(path.join(f.agentDir, "roles/backend-architect.md"));
  expect(resolveRole(await discoverRoles(f), "backend-architect").status).toBe(
    "missing",
  );
});
test("shared command prefix preserves multiline and literal flags; invalid or duplicate values fail", () => {
  expect(
    parseRolePrefix("--role=code-reviewer Review\n  exact indent\n"),
  ).toEqual({ role: "code-reviewer", task: "Review\n  exact indent\n" });
  expect(parseRolePrefix("Implement --role none later")).toEqual({
    task: "Implement --role none later",
  });
  expect(parseRolePrefix("-- --role is task text")).toEqual({
    task: "--role is task text",
  });
  for (const value of [
    "--role",
    "--role=",
    "--role ../file task",
    "--role none --role default task",
    "--role -- task",
  ])
    expect(() => parseRolePrefix(value)).toThrow();
});
test("simultaneous same-agent prompt preparation keeps snapshots separate with replace/context/skill/extension settings", async () => {
  const f = await fixture();
  await f.put("user/roles/backend-architect.md", "ARCHITECT_ROLE");
  await f.put("user/roles/code-reviewer.md", "REVIEWER_ROLE");
  const catalog = await discoverRoles(f);
  for (const replace of [false, true]) {
    const agent: AgentConfig = {
      name: "executor",
      description: "fixture",
      role: "backend-architect",
      systemPrompt: "AGENT_BODY",
      source: "user",
      filePath: "fixture.md",
      skills: false,
      context: false,
      extensions: [],
      ...(replace ? { replacePrompt: true } : {}),
    };
    const roles = [undefined, "none", "code-reviewer"].map((input) =>
      resolveRole(catalog, agent.role, input),
    );
    const setups = await Promise.all(
      roles.map((role) => beginPromptSetup(agent, role)),
    );
    for (const [i, setup] of setups.entries()) {
      if (!("tmpPrompt" in setup) || !setup.tmpPrompt)
        throw new Error("Prompt setup failed");
      const text = await readFile(setup.tmpPrompt.filePath, "utf8");
      expect(text).toContain("AGENT_BODY");
      expect(text.split("ARCHITECT_ROLE").length - 1).toBe(i === 0 ? 1 : 0);
      expect(text.split("REVIEWER_ROLE").length - 1).toBe(i === 2 ? 1 : 0);
      const args = buildPiArgs({
        agent,
        task: "task",
        effectiveModel: {},
        thinking: "off",
        resolvedSkills: { args: [] },
        tmpPrompt: setup.tmpPrompt,
      });
      expect(args).toContain(
        replace ? "--system-prompt" : "--append-system-prompt",
      );
      expect(args.at(-2)).toBe(SUBAGENT_RESULT_CONTRACT);
      expect(args).toContain("--no-context-files");
      expect(args).toContain("--no-skills");
      expect(args).toContain("--no-extensions");
      await cleanupPromptSetupResult(setup);
      expect(await Bun.file(setup.tmpPrompt.filePath).exists()).toBe(false);
    }
    expect(agent.systemPrompt).toBe("AGENT_BODY");
    expect(agent.role).toBe("backend-architect");
  }
});
test("offline importer excludes docs, preserves English body/license, is idempotent and protects custom edits", async () => {
  const f = await fixture();
  const source = path.join(f.root, "source");
  await f.put("source/LICENSE", "MIT License\nCopyright (c) fixture");
  await f.put(
    "source/README.md",
    "---\nname: fake\ndescription: fake\n---\nIGNORE",
  );
  await f.put(
    "source/strategy/runbook.md",
    "---\nname: fake\ndescription: fake\n---\nIGNORE",
  );
  const originalBody = "\n# Architect\n\nPreserve English.\n  Indented line.\n";
  await f.put(
    "source/engineering/engineering-backend-architect.md",
    `---\nname: Backend Architect\ndescription: Design contracts\n---\n${originalBody}`,
  );
  const run = promisify(execFile);
  await run("git", ["init"], { cwd: source });
  await run("git", ["add", "."], { cwd: source });
  await run(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: source },
  );
  const options = {
    source,
    rolesRoot: path.join(f.agentDir, "roles"),
    provenanceRoot: path.join(f.agentDir, "role-sources/agency-agents"),
    all: true,
  };
  expect(
    (await importAgencyRoles({ ...options, dryRun: true })).counts?.imported,
  ).toBe(1);
  expect(
    await Bun.file(
      path.join(options.rolesRoot, "engineering/backend-architect.md"),
    ).exists(),
  ).toBe(false);
  expect((await importAgencyRoles(options)).counts?.imported).toBe(1);
  const file = path.join(options.rolesRoot, "engineering/backend-architect.md");
  expect((await readFile(file, "utf8")).endsWith(originalBody)).toBe(true);
  expect(
    await readFile(path.join(options.provenanceRoot, "LICENSE"), "utf8"),
  ).toContain("Copyright");
  expect((await importAgencyRoles(options)).counts?.unchanged).toBe(1);
  await writeFile(file, "CUSTOM EDIT");
  expect(
    (await importAgencyRoles({ ...options, update: true })).counts?.conflicts,
  ).toBe(1);
  expect(await readFile(file, "utf8")).toBe("CUSTOM EDIT");
  expect(
    await Bun.file(
      path.join(
        options.provenanceRoot,
        "conflicts/backend-architect.proposed.md",
      ),
    ).exists(),
  ).toBe(true);
  expect(
    (await importAgencyRoles({ ...options, update: true, resolve: "replace" }))
      .counts?.updated,
  ).toBe(1);
  await f.put(
    "source/design/backend-architect.md",
    "---\nname: Collision\ndescription: fixture\n---\nBODY",
  );
  await expect(importAgencyRoles(options)).rejects.toThrow("collisions");
});
