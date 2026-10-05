import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export type TerminationSignal = "SIGTERM" | "SIGKILL";

export type TerminationMetadata = {
  cancelRequestedAt: number;
  cancelReason?: string | undefined;
  terminationSignal?: TerminationSignal | undefined;
  escalated: boolean;
  processTreeKilled: boolean;
  target: "direct" | "tree";
  fallbackCause?: string | undefined;
};

export type SleepInhibitorHandle = {
  release: () => Promise<void>;
};

export type SleepInhibitorAdapterHandle = {
  release?: () => unknown;
};

export type SleepInhibitorAdapter = {
  supported?: () => boolean | Promise<boolean>;
  acquire: (pid: number) => unknown;
};

export type SleepInhibitorHelperProcess = {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | string | null;
  kill?: (signal?: NodeJS.Signals | number) => unknown;
  on?: (event: "error", listener: (error: Error) => void) => unknown;
  unref?: () => unknown;
};

export type HostSleepInhibitorAdapterOptions = {
  platform?: NodeJS.Platform;
  environment?: Partial<NodeJS.ProcessEnv>;
  getEnvironment?: () => Partial<NodeJS.ProcessEnv>;
  commandExists?: (command: string) => boolean | Promise<boolean>;
  spawnHelper?: (
    command: string,
    args: string[],
    options: { stdio: "ignore"; detached: true },
  ) => SleepInhibitorHelperProcess;
};

type TimerHandle = unknown;

type TerminationState = {
  metadata: TerminationMetadata;
  promise: Promise<TerminationMetadata>;
  settled: boolean;
  timer?: TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
  resolve: (metadata: TerminationMetadata) => void;
};

export type TerminateChildProcessOptions = {
  reason?: string;
  timeoutMs?: number;
  tree?: boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  killProcess?: (proc: ChildProcess, signal: TerminationSignal) => unknown;
  processTreeDetached?: boolean;
  killProcessTree?: (
    proc: ChildProcess,
    signal: TerminationSignal,
    platform: NodeJS.Platform,
  ) => unknown;
  killProcessGroup?: (pid: number, signal: TerminationSignal) => unknown;
  runTaskkill?: (args: string[]) => unknown;
};

const DEFAULT_TIMEOUT_MS = 4_000;
const CAFFEINATE_COMMAND = "caffeinate";
const SYSTEMD_INHIBIT_COMMAND = "systemd-inhibit";
const GNOME_SESSION_INHIBIT_COMMAND = "gnome-session-inhibit";
const KDE_INHIBIT_COMMAND = "kde-inhibit";
const POWERSHELL_COMMAND = "powershell.exe";
const SHELL_COMMAND = "/bin/sh";
const noopSleepInhibitorHandle: SleepInhibitorHandle = {
  async release() {},
};
const terminationStates = new WeakMap<ChildProcess, TerminationState>();

export function getProcessTreeSpawnOptions(
  tree: boolean,
  platform: NodeJS.Platform = process.platform,
): { detached?: boolean } {
  return tree && platform !== "win32" ? { detached: true } : {};
}

export function isFinitePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isFinite(pid);
}

function isAdapterHandle(
  handle: unknown,
): handle is SleepInhibitorAdapterHandle {
  return typeof handle === "object" && handle !== null;
}

function makeSleepInhibitorHandle(
  adapterHandle: SleepInhibitorAdapterHandle,
): SleepInhibitorHandle {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await adapterHandle.release?.();
      } catch {
        /* adapter release failures are non-fatal */
      }
    },
  };
}

async function defaultCommandExists(command: string): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawn("/bin/sh", ["-c", `command -v ${command}`], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  } catch {
    /* missing, non-executable, failed, or throwing lookups return false */
    return false;
  }
}

function helperHasEnded(helper: SleepInhibitorHelperProcess): boolean {
  return (
    (helper.exitCode ?? null) !== null || (helper.signalCode ?? null) !== null
  );
}

function makeHelperHandle(
  helper: SleepInhibitorHelperProcess,
): SleepInhibitorAdapterHandle {
  helper.on?.("error", () => undefined);
  helper.unref?.();
  return {
    release() {
      if (helperHasEnded(helper)) return;
      helper.kill?.("SIGTERM");
    },
  };
}

function getDesktopTokens(desktop: string | undefined): Set<string> {
  return new Set(
    (desktop ?? "")
      .toLowerCase()
      .split(/[\s:;,+/]+/u)
      .filter(Boolean),
  );
}

function getLinuxDesktopTokens(
  getEnvironment: () => Partial<NodeJS.ProcessEnv>,
): Set<string> {
  try {
    return getDesktopTokens(getEnvironment()["XDG_CURRENT_DESKTOP"]);
  } catch {
    return new Set<string>();
  }
}

function hasGnomeCompatibleDesktop(tokens: Set<string>): boolean {
  return tokens.has("gnome") || tokens.has("ubuntu");
}

function hasKdeCompatibleDesktop(tokens: Set<string>): boolean {
  return tokens.has("kde") || tokens.has("plasma");
}

async function commandExistsSafely(
  commandExists: (command: string) => boolean | Promise<boolean>,
  command: string,
): Promise<boolean> {
  try {
    return await commandExists(command);
  } catch {
    return false;
  }
}

function makePidPollingShellArgs(pid: number): string[] {
  return [
    SHELL_COMMAND,
    "-c",
    `while kill -0 ${pid} 2>/dev/null && [ "$(cut -d' ' -f4 /proc/$$/stat 2>/dev/null)" != "1" ]; do sleep 1; done`,
  ];
}

function makeSystemdInhibitArgs(pid: number): string[] {
  return [
    "--what=sleep:idle",
    "--who=pi-subagent",
    "--why=subagent running",
    "--mode=block",
    ...makePidPollingShellArgs(pid),
  ];
}

function makeGnomeSessionInhibitArgs(pid: number): string[] {
  return [
    "--app-id=pi-subagent",
    "--inhibit=suspend:idle",
    "--reason=subagent running",
    ...makePidPollingShellArgs(pid),
  ];
}

function makeKdeInhibitArgs(pid: number): string[] {
  return ["--power", "--screenSaver", ...makePidPollingShellArgs(pid)];
}

function makePowerShellInhibitArgs(pid: number): string[] {
  const script = [
    "Add-Type -Namespace PiSubagent -Name NativeMethods -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "[PiSubagent.NativeMethods]::SetThreadExecutionState(0x80000001) | Out-Null",
    `try { while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 } } finally { [PiSubagent.NativeMethods]::SetThreadExecutionState(0x80000000) | Out-Null }`,
  ].join("; ");
  return ["-NonInteractive", "-Command", script];
}

async function acquireLinuxSleepInhibitor(
  pid: number,
  getEnvironment: () => Partial<NodeJS.ProcessEnv>,
  commandExists: (command: string) => boolean | Promise<boolean>,
  spawnHelper: (
    command: string,
    args: string[],
    options: { stdio: "ignore"; detached: true },
  ) => SleepInhibitorHelperProcess,
): Promise<SleepInhibitorAdapterHandle> {
  const spawnSingleHelper = (
    command: string,
    args: string[],
  ): SleepInhibitorAdapterHandle => {
    try {
      return makeHelperHandle(
        spawnHelper(command, args, {
          stdio: "ignore",
          detached: true,
        }),
      );
    } catch {
      /* chosen-helper spawn failures degrade to empty handle */
      return {};
    }
  };
  const tokens = getLinuxDesktopTokens(getEnvironment);
  if (
    hasGnomeCompatibleDesktop(tokens) &&
    (await commandExistsSafely(commandExists, GNOME_SESSION_INHIBIT_COMMAND))
  )
    return spawnSingleHelper(
      GNOME_SESSION_INHIBIT_COMMAND,
      makeGnomeSessionInhibitArgs(pid),
    );
  if (
    hasKdeCompatibleDesktop(tokens) &&
    (await commandExistsSafely(commandExists, KDE_INHIBIT_COMMAND))
  )
    return spawnSingleHelper(KDE_INHIBIT_COMMAND, makeKdeInhibitArgs(pid));
  if (await commandExistsSafely(commandExists, SYSTEMD_INHIBIT_COMMAND))
    return spawnSingleHelper(
      SYSTEMD_INHIBIT_COMMAND,
      makeSystemdInhibitArgs(pid),
    );
  return {};
}

export function makeHostSleepInhibitorAdapter(
  options: HostSleepInhibitorAdapterOptions = {},
): SleepInhibitorAdapter {
  const platform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const getEnvironment =
    options.getEnvironment ?? (() => options.environment ?? process.env);
  const spawnHelper =
    options.spawnHelper ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  return {
    async supported() {
      if (platform === "win32") return true;
      if (platform === "darwin")
        return commandExistsSafely(commandExists, CAFFEINATE_COMMAND);
      if (platform === "linux") {
        const tokens = getLinuxDesktopTokens(getEnvironment);
        if (
          hasGnomeCompatibleDesktop(tokens) &&
          (await commandExistsSafely(
            commandExists,
            GNOME_SESSION_INHIBIT_COMMAND,
          ))
        )
          return true;
        if (
          hasKdeCompatibleDesktop(tokens) &&
          (await commandExistsSafely(commandExists, KDE_INHIBIT_COMMAND))
        )
          return true;
        return commandExistsSafely(commandExists, SYSTEMD_INHIBIT_COMMAND);
      }
      return false;
    },
    acquire(pid) {
      if (platform === "darwin") {
        const helper = spawnHelper(
          CAFFEINATE_COMMAND,
          ["-dimsu", "-w", String(pid)],
          { stdio: "ignore", detached: true },
        );
        return makeHelperHandle(helper);
      }
      if (platform === "linux") {
        return acquireLinuxSleepInhibitor(
          pid,
          getEnvironment,
          commandExists,
          spawnHelper,
        );
      }
      if (platform === "win32") {
        const helper = spawnHelper(
          POWERSHELL_COMMAND,
          makePowerShellInhibitArgs(pid),
          {
            stdio: "ignore",
            detached: true,
          },
        );
        return makeHelperHandle(helper);
      }
      return {};
    },
  };
}

export async function acquireChildSleepInhibitor(
  pid: unknown,
  adapter?: SleepInhibitorAdapter,
): Promise<SleepInhibitorHandle> {
  if (!isFinitePid(pid) || !adapter) return noopSleepInhibitorHandle;
  try {
    if ((await adapter.supported?.()) === false)
      return noopSleepInhibitorHandle;
    const handle = await adapter.acquire(pid);
    return isAdapterHandle(handle)
      ? makeSleepInhibitorHandle(handle)
      : noopSleepInhibitorHandle;
  } catch {
    /* unsupported platforms or acquisition failures degrade to no-op handle */
    return noopSleepInhibitorHandle;
  }
}

function childHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode != null;
}

function hasPid(proc: ChildProcess): proc is ChildProcess & { pid: number } {
  return isFinitePid(proc.pid);
}

function settleState(state: TerminationState): void {
  if (state.settled) return;
  state.settled = true;
  if (state.timer) state.clearTimeout(state.timer);
  delete state.timer;
  state.resolve(state.metadata);
}

function makeState(
  proc: ChildProcess,
  options: TerminateChildProcessOptions,
): TerminationState {
  let resolveState!: (metadata: TerminationMetadata) => void;
  const metadata: TerminationMetadata = {
    cancelRequestedAt: options.now?.() ?? Date.now(),
    cancelReason: options.reason,
    escalated: false,
    processTreeKilled: false,
    target: options.tree ? "tree" : "direct",
  };
  const state: TerminationState = {
    metadata,
    promise: new Promise((resolve) => {
      resolveState = resolve;
    }),
    settled: false,
    clearTimeout:
      options.clearTimeout ?? ((timer) => clearTimeout(timer as never)),
    resolve: resolveState,
  };
  const settle = () => settleState(state);
  proc.once("exit", settle);
  proc.once("close", settle);
  proc.once("error", settle);
  return state;
}

function sendDirectSignal(
  proc: ChildProcess,
  signal: TerminationSignal,
  state: TerminationState,
  options: TerminateChildProcessOptions,
): void {
  (options.killProcess ?? ((child, nextSignal) => child.kill(nextSignal)))(
    proc,
    signal,
  );
  state.metadata.target = "direct";
  state.metadata.processTreeKilled = false;
}

function sendTreeSignal(
  proc: ChildProcess,
  signal: TerminationSignal,
  state: TerminationState,
  options: TerminateChildProcessOptions,
): void {
  const platform = options.platform ?? process.platform;
  if (!hasPid(proc)) throw new Error("missing child PID");
  const pid = proc.pid;
  if (!options.tree) {
    sendDirectSignal(proc, signal, state, options);
    return;
  }
  const markTreeKilled = () => {
    state.metadata.target = "tree";
    state.metadata.processTreeKilled = true;
  };
  if (options.killProcessTree) {
    options.killProcessTree(proc, signal, platform);
    markTreeKilled();
    return;
  }
  if (platform !== "win32") {
    if (!options.processTreeDetached)
      throw new Error("process tree not detached");
    (
      options.killProcessGroup ??
      ((pid, nextSignal) => process.kill(pid, nextSignal))
    )(-pid, signal);
    markTreeKilled();
    return;
  }
  if (signal === "SIGKILL") {
    const result = (
      options.runTaskkill ?? ((args) => Bun.spawnSync(["taskkill", ...args]))
    )(["/pid", String(pid), "/t", "/f"]);
    if (
      result &&
      typeof result === "object" &&
      "exitCode" in result &&
      result.exitCode !== 0
    ) {
      throw new Error(`taskkill exited with code ${String(result.exitCode)}`);
    }
    markTreeKilled();
    return;
  }
  throw new Error("unsupported tree termination platform");
}

function sendTerminationSignal(
  proc: ChildProcess,
  signal: TerminationSignal,
  state: TerminationState,
  options: TerminateChildProcessOptions,
): void {
  if (state.settled || childHasExited(proc) || !hasPid(proc)) {
    settleState(state);
    return;
  }
  try {
    state.metadata.terminationSignal = signal;
    sendTreeSignal(proc, signal, state, options);
  } catch (error) {
    try {
      state.metadata.fallbackCause =
        error instanceof Error ? error.message : "tree termination failed";
      sendDirectSignal(proc, signal, state, options);
    } catch {
      settleState(state);
    }
  }
}

export function terminateChildProcess(
  proc: ChildProcess,
  options: TerminateChildProcessOptions = {},
): Promise<TerminationMetadata> {
  const existing = terminationStates.get(proc);
  if (existing) return existing.promise;
  const state = makeState(proc, options);
  terminationStates.set(proc, state);
  if (childHasExited(proc) || !hasPid(proc)) {
    settleState(state);
    return state.promise;
  }
  sendTerminationSignal(proc, "SIGTERM", state, options);
  if (!state.settled) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const setTimer = options.setTimeout ?? setTimeout;
    state.timer = setTimer(() => {
      if (state.settled || childHasExited(proc)) {
        settleState(state);
        return;
      }
      state.metadata.escalated = true;
      sendTerminationSignal(proc, "SIGKILL", state, options);
    }, timeoutMs);
    (state.timer as { unref?: () => void } | undefined)?.unref?.();
  }
  return state.promise;
}
