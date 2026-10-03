---
name: pi-subagent-usage
description: Delegate isolated tasks through the installed subagent tool or Pi commands, with optional professional roles and tracked jobs.
---

Choose an agent for its execution strategy, model, effort, and tools. A role is a professional perspective that complements task-specific skills. Pass a complete bounded task because children have isolated context.

Use the `subagent` tool. Omit `role` or use `"default"` to apply the child's own agent configuration. Use `"none"` when the task or user calls for ignoring that role. Supply an existing ID to override the role for this invocation only. Each nested call defaults to its own child configuration; never copy the parent's role implicitly. Unavailable roles are silently ignored without preventing execution, and a missing explicit override does not fall back to the default.

Discover unfamiliar IDs with `roles` (`{"action":"list","query":"backend"}` or `{"action":"show","id":"backend-architect"}`). Respect the current tool allowlist; use allowed catalog-file reads or simply default if discovery is unavailable. Never invent IDs. Pass `role` as a structured argument, rather than embedding the option in tool task prose.

```json
{"agent":"executor","task":"Implement the endpoint"}
{"agent":"executor","role":"default","task":"Implement the endpoint"}
{"agent":"executor","role":"none","task":"Implement the endpoint"}
{"agent":"executor","role":"code-reviewer","task":"Review the endpoint"}
```

Interactive equivalents:

```text
@executor Implement the endpoint
@executor --role default Implement the endpoint
@executor --role none Implement the endpoint
@executor --role code-reviewer Review the endpoint
@agent:executor --role code-reviewer Review the endpoint
/delegate executor --role code-reviewer Review the endpoint
/run executor --role code-reviewer Review the endpoint
/run --debug executor --role=code-reviewer Review the endpoint
```

Options belong immediately after the agent name. `--role=<value>` is also supported. `--` ends option parsing; a later `--role` in task prose stays literal. `/run executor` retains the agent's task-default behavior. Debug output requires host authorization.

An optional agent default is a filename ID, not a path:

```yaml
---
name: executor
description: Execute bounded implementation tasks
role: backend-architect
---
Follow the project's implementation and validation rules.
```

Roles live under `~/.pi/agent/roles` or the nearest ancestor `.pi/roles`; project IDs override user IDs according to project trust. Use `/role`, `/role show`, and `/roles` to browse. A named main agent uses its own default; independent main selection requires `/agent reset`. Role selection changes no tools, model, effort, extensions, or skills, and does not erase conversation history.

Continue using tracked progress, `/jobs`, `/cancel-subagent <requestId|all>`, and completion results. Root jobs run in the background; nested tool calls await completion. Never launch an alternate process merely to choose a role, and do not edit an agent file for an invocation override.
