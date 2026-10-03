# Roles migration and rollback

Install pi-subagent `0.13.0-rodrigo.1` and pi-agent-switcher `0.4.0-rodrigo.1` together. Keep exactly one registered source of each. No standalone roles extension is registered: subagent owns `roles` and `/run`; switcher owns `/role` and `/roles`.

The switcher requires the role-aware `rodrigojager:pi-subagent:delegate:v2` bridge. Missing v2 returns a compatibility error and preserves the task; it never retries v1. Updated subagent retains `delegate:v1` for older clients, mapping those calls to child-default role semantics. Capability handshakes do not launch work, and reusing an accepted run function reuses its execution promise.

The bundled `skills/pi-subagent-usage/SKILL.md` is registered through `pi.skills` and packaged once. Use this lifecycle rather than a separate Python or external-Pi helper. Existing optional role frontmatter and old historical entries are compatible with rollback; invocation overrides never rewrite Markdown definitions.

Before installation, save the current settings and package source entries. Install into new versioned directories, preserving the previous directories. Change only the two package entries using Pi's supported local package mechanism. Do not interrupt existing jobs; `/reload` when idle, or start a new Pi session. Verify loaded `/role`, `/roles`, `roles`, `/run`, and the single bundled skill.

Rollback restores the previous two package entries and reloads when idle. Imported role data can remain, and old versions ignore optional `role` metadata. Do not delete custom roles or user agent files. Primary selection affects current prompt contributions, not previously stored conversation history.
