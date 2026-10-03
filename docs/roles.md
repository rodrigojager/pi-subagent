# Professional roles

Roles are offline Markdown instruction data, independent of execution agents and task-specific skills. Loading a role changes no provider, model, thinking, tools, skills, or extensions. The pure API is exported at `@mystilleef/pi-subagent/roles`; the switcher consumes it through its production dependency alias `pi-subagent-runtime/roles`. Importing the core registers nothing.

Add `role: backend-architect` to an existing agent's YAML frontmatter. Use a lowercase portable filename ID, without a path or `.md`. Invalid optional metadata is ignored and available as `roleDiagnostic`; absent or unreadable documents never invalidate the agent or emit a passive warning.

User roles live in `getAgentDir()/roles` (normally `~/.pi/agent/roles`). Project roles use the nearest ancestor `.pi/roles` from the invocation cwd, independently of `.pi/agents`. Category subdirectories are recursive and organizational. Trusted project IDs shadow user IDs, including malformed project entries. Duplicate IDs in a scope are omitted with diagnostics. Untrusted project content is excluded; interactive project-role delegation follows the existing project-agent confirmation policy, including when a global agent selects a project role.

```markdown
---
name: Backend Architect
description: Evaluate contracts, reliability and maintainability.
category: Engineering
---

Consider failure modes and data consistency. Keep changes proportional to the task.
```

Plain Markdown also works. The filename determines the ID; an optional metadata `id` must agree. `default` and `none` are reserved selection modes. Only the body enters the model prompt. Unsupported execution configuration in role metadata has no effect.

## Invocation choices

| Invocation role | Effective role |
| --- | --- |
| omitted / `default` | This child's agent frontmatter role |
| `none` | No role |
| named ID | Only that role; missing lookup yields no role without fallback |

Every fresh or nested invocation starts from its own agent default. Choices never mutate an agent definition, shared discovery object, another job, or the next call.

```text
@executor Implement the endpoint
@executor --role default Implement the endpoint
@executor --role none Implement the endpoint
@executor --role code-reviewer Review the endpoint
@agent:executor --role=code-reviewer Review the endpoint
/delegate executor --role code-reviewer Review the endpoint
/run executor --role code-reviewer Review the endpoint
/run --debug executor --role code-reviewer Review the endpoint
/run executor
```

Only options immediately after the agent name are parsed. Missing/duplicate values are errors and do not launch. `--` ends parsing, preserving flags mentioned in task prose. Task multiline content stays intact. Existing attachments and native file-mention behavior remain unchanged. Debug requires the existing host authorization.

```json
{"agent":"executor","task":"Implement the endpoint"}
{"agent":"executor","role":"default","task":"Implement the endpoint"}
{"agent":"executor","role":"none","task":"Implement the endpoint"}
{"agent":"executor","role":"code-reviewer","task":"Review the endpoint"}
```

The read-only `roles` tool accepts `action: list` with optional `query`, `offset`, and `limit` (1–50); `action: show` requires `id`. Listing returns metadata and `nextOffset` when needed. Showing returns the selected instructions and provenance. Neither operation selects a role, imports, or delegates. Agent allowlists still govern tool visibility.

## Primary conversation and UI

The switcher owns `/role`, `/roles`, and the single structured `professional_role` prompt section. `/role` opens a searchable picker; `/role <id>` and `/role none` select only in Pi default. `/role show` previews without adding instructions to chat history. `/roles [refresh|query]` lists metadata and diagnostics.

A named main agent always uses its own frontmatter role. Its `/role` browser is read-only, labeled “Role from agent configuration”. Use `/agent reset` first to select an independent main role. The saved base-conversation ID is restored when returning to Pi default and never enters named-agent or child resolution. Branch state stores IDs only; new sessions have no base role. Old session entries remain readable.

The main picker and status show effective role names. Delegation opens a separate role picker initially on Default for every task. Escape cancels. Search covers ID/name/category/description and supports real terminal Input handling and RPC selection. Live/result cards and `/jobs` display each run's captured role; old records omit the field rather than claiming None.

Each invocation discovers a fresh filesystem catalog and captures a frozen body/metadata snapshot. This intentionally uses no persistent role cache: edits, deletion, workspace changes, and trust changes are visible on the next invocation. Main roles refresh at the next turn or explicit selection/inspection. Switching removes only the current owned contribution and does not delete earlier conversation history. Child role composition happens in the host and works with `replace_prompt`, `context: false`, `skills: false`, and `extensions: false`; the completion contract stays last.

## Agency Agents import

Run from this source/package directory with Bun. All commands below support Windows argument arrays and an offline source checkout. Runtime loading never accesses the network.

```text
bun run roles:import -- --source <checkout> --list
bun run roles:import -- --source <checkout> --scope user --all --dry-run
bun run roles:import -- --source <checkout> --scope user --all
bun run roles:import -- --source <checkout> --scope user --select backend-architect,code-reviewer,ui-designer
bun run roles:import -- --source <checkout> --scope project --cwd <project> --category engineering
bun run roles:import -- --scope user --all --update
```

Without `--source`, an explicit importer invocation clones the source to `getAgentDir()/role-sources/agency-agents` if absent. `--update` fetches and fast-forwards that cache. Fetch failure occurs before catalog writes. Supplying `--source` never fetches, so an existing checkout supports offline updates. Dry-run requires an existing checkout and performs no writes/network.

Only recognized specialist category directories with agent name/description metadata are imported; docs, strategy, translations, examples, scripts, and integrations are excluded. Bodies retain their original English text. Category prefixes are removed deterministically. `--map <JSON-file>` supplies stable source-path-to-ID mappings if IDs collide. Collisions and invalid input fail before role writes.

Provenance, hashes, exact upstream revision, mappings, LICENSE, backups, and proposed conflicts live under `role-sources/agency-agents`, outside the catalog. Repeating an import is idempotent. `--update` replaces unedited managed files atomically. Custom/edited files are conflicts and remain intact; proposed replacements are written outside the catalog. `--resolve keep` preserves without proposals; `--resolve replace` explicitly replaces same-destination conflicts while backing up their text. A different local path with the same ID remains a conflict. Upstream removals never delete local files. The summary reports imported, updated, unchanged, conflicts, skipped, and failed counts.

Agency Agents is MIT licensed; every import preserves its actual LICENSE and attribution. See [Agency Agents](https://github.com/msitarzewski/agency-agents) and its [license](https://github.com/msitarzewski/agency-agents/blob/main/LICENSE).
