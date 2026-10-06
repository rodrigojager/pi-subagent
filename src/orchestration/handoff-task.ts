export interface HandoffTaskInput {
  task?: string;
  ticketPath?: string;
  worktreePath?: string;
}

export function formatHandoffTask(input: HandoffTaskInput): string {
  const task = input.task?.trim() ?? "";
  const ticketPath = input.ticketPath?.trim();
  const worktreePath = input.worktreePath?.trim();
  if (input.ticketPath !== undefined && !ticketPath)
    throw new Error("ticketPath must not be blank");
  if (input.worktreePath !== undefined && !worktreePath)
    throw new Error("worktreePath must not be blank");
  const lines: string[] = [];
  if (worktreePath) {
    lines.push(`Worktree: ${worktreePath}`);
    lines.push("Use this worktree for edits and tests.");
  }
  if (ticketPath)
    lines.push(
      `Read the full ticket at ${ticketPath} before editing. Implement its acceptance criteria.`,
    );
  if (task)
    lines.push(ticketPath ? `Supplemental instructions: ${task}` : task);
  return lines.join("\n");
}
