import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "setTimeout(() => process.exit(0), 15000)"],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  },
);
grandchild.unref();
process.send?.({ grandchildPid: grandchild.pid });
setTimeout(() => process.exit(0), 16000);
