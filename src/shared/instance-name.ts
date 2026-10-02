// Display labels are numbered for the lifetime of this extension module.
// The request UUID remains the identity used for cancellation and job tracking.
let instanceNumber = 0;

export function generateSubagentInstanceName(): string {
  instanceNumber += 1;
  return `#${instanceNumber}`;
}
