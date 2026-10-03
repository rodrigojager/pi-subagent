import { declaredRole, normalizeRoleRequest } from "./request.js";
import type { RoleCatalog, RoleMetadata, RoleResolution } from "./types.js";

export function resolveRole(
  catalog: RoleCatalog,
  agentRole?: string,
  input?: unknown,
  origin?: RoleMetadata["origin"],
): RoleResolution {
  const requested = normalizeRoleRequest(input);
  const selectedOrigin =
    origin ?? (requested.kind === "default" ? "agent-default" : "invocation");
  const base = { requested, origin: selectedOrigin };
  if (requested.kind === "none")
    return Object.freeze({ ...base, status: "none" });
  const id =
    requested.kind === "named" ? requested.id : declaredRole(agentRole);
  if (!id) return Object.freeze({ ...base, status: "none" });
  const role = catalog.roles.find((r) => r.id === id);
  if (!role)
    return Object.freeze({
      ...base,
      requestedId: id,
      status: catalog.rejected.get(id) ?? "missing",
    });
  return Object.freeze({
    ...base,
    requestedId: id,
    effectiveId: id,
    displayName: role.name,
    source: role.source,
    sourcePath: role.sourcePath,
    sourceRevision: role.sourceRevision,
    contentHash: role.contentHash,
    body: role.body,
    status: "resolved",
  });
}
export function roleMetadata(role: RoleResolution): RoleMetadata {
  return Object.freeze({
    requested: normalizeRoleRequest(
      role.requested.kind === "named" ? role.requested.id : role.requested.kind,
    ),
    origin: role.origin,
    status: role.status,
    requestedId: role.requestedId,
    effectiveId: role.effectiveId,
    displayName: role.displayName,
    source: role.source,
    sourceRevision: role.sourceRevision,
    contentHash: role.contentHash,
  });
}
export function formatRole(role?: RoleMetadata): string {
  if (!role) return "";
  if (role.status !== "resolved") return "Role: None";
  return `Role: ${role.displayName ?? role.effectiveId} (${role.origin === "invocation" ? "override" : role.origin === "agent-default" ? "default" : "base"})`;
}
