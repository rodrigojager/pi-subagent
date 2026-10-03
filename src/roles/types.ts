export type RoleRequest =
  | { readonly kind: "default" }
  | { readonly kind: "none" }
  | { readonly kind: "named"; readonly id: string };

export interface RoleMetadata {
  readonly requested: RoleRequest;
  readonly origin: "agent-default" | "invocation" | "base-conversation";
  readonly requestedId?: string | undefined;
  readonly effectiveId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly source?: "project" | "user" | undefined;
  readonly sourceRevision?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly status: "resolved" | "none" | "missing" | "invalid" | "unreadable";
}
export interface RoleResolution extends RoleMetadata {
  readonly sourcePath?: string | undefined;
  readonly body?: string | undefined;
}
export interface RoleDocument {
  id: string;
  name: string;
  description: string;
  category: string;
  source: "project" | "user";
  sourcePath: string;
  sourceRevision?: string | undefined;
  sourceUrl?: string | undefined;
  contentHash: string;
  body: string;
}
export interface RoleCatalog {
  roles: RoleDocument[];
  diagnostics: string[];
  rejected: Map<string, "invalid" | "unreadable">;
  userRoot: string;
  projectRoot?: string | undefined;
}
