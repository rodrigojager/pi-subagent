const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 125;

export function spinnerFrame(now = Date.now()): string {
  return (
    FRAMES[
      Math.floor(Math.max(0, now) / SPINNER_INTERVAL_MS) % FRAMES.length
    ] ?? "⠋"
  );
}
