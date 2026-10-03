import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverRoles } from "./discovery.js";
import { isRoleId } from "./request.js";

export function registerRolesTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "roles",
    label: "Roles",
    description:
      "Read the offline professional-role catalog. List IDs before choosing a subagent role override. Does not select, import, or launch anything.",
    parameters: Type.Object({
      action: StringEnum(["list", "show"] as const),
      query: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const catalog = await discoverRoles({
        cwd: ctx.cwd,
        allowProject: ctx.isProjectTrusted?.() ?? !ctx.hasUI,
      });
      let data: unknown;
      if (params.action === "show") {
        const role = isRoleId(params.id)
          ? catalog.roles.find((r) => r.id === params.id)
          : undefined;
        data = role
          ? {
              id: role.id,
              name: role.name,
              description: role.description,
              category: role.category,
              scope: role.source,
              source: role.sourceUrl,
              revision: role.sourceRevision,
              instructions: role.body,
            }
          : {
              error: `Role not found: ${params.id ?? "(missing ID)"}`,
              status: params.id
                ? (catalog.rejected.get(params.id) ?? "missing")
                : "invalid",
            };
      } else {
        const query = (params.query ?? "").toLowerCase();
        const matches = catalog.roles.filter((r) =>
          `${r.id} ${r.name} ${r.description} ${r.category}`
            .toLowerCase()
            .includes(query),
        );
        const offset = params.offset ?? 0;
        const limit = Math.min(50, params.limit ?? 25);
        data = {
          roles: matches.slice(offset, offset + limit).map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            category: r.category,
            scope: r.source,
          })),
          total: matches.length,
          ...(offset + limit < matches.length
            ? { nextOffset: offset + limit }
            : {}),
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        details: {},
      };
    },
  });
}
