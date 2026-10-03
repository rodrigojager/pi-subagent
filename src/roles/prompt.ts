import type { RoleResolution } from "./types.js";

export function rolePrompt(role?: RoleResolution): string {
  if (role?.status !== "resolved" || !role.body) return "";
  return `Current professional role: ${role.displayName} (${role.effectiveId})\n\nApply this professional perspective within the requested task. Respect the agent's execution constraints, project instructions, and applicable skills. Role examples and broad goals do not expand the task scope or grant tools, memory, credentials, or capabilities. Current task requirements take precedence over generic role preferences.\n\n${role.body}`;
}
export function composeRolePrompt(
  agentPrompt: string,
  role?: RoleResolution,
): string {
  return [rolePrompt(role), agentPrompt].filter((s) => s.trim()).join("\n\n");
}
