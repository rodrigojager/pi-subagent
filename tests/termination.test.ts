import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as terminationModule from "../src/child/termination.js";
import {
  acquireChildSleepInhibitor,
  getProcessTreeSpawnOptions,
  isFinitePid,
  makeHostSleepInhibitorAdapter,
  type SleepInhibitorAdapter,
  type SleepInhibitorHelperProcess,
  type TerminationSignal,
  terminateChildProcess,
} from "../src/child/termination.js";

type FakeChild = EventEmitter & {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  signals: TerminationSignal[];
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function makeChild(overrides: Partial<FakeChild> = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 123;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal as TerminationSignal);
    return true;
  };
  return Object.assign(child, overrides);
}

function makeTimers() {
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  return {
    timers,
    cleared,
    setTimeout(callback: () => void, _ms?: number) {
      timers.push(callback);
      return callback;
    },
    clearTimeout(timer: unknown) {
      cleared.push(timer);
    },
  };
}

describe("acquireChildSleepInhibitor", () => {
  test("valid finite PIDs acquire one independent release handle", async () => {
    const acquired: number[] = [];
    const released: number[] = [];
    const adapter: SleepInhibitorAdapter = {
      acquire(pid) {
        acquired.push(pid);
        return {
          release() {
            released.push(pid);
          },
        };
      },
    };
    const first = await acquireChildSleepInhibitor(101, adapter);
    const second = await acquireChildSleepInhibitor(202, adapter);
    await first.release();
    await second.release();
    expect(acquired).toEqual([101, 202]);
    expect(released).toEqual([101, 202]);
  });
  test("invalid and missing PIDs return no-op handles without acquisition", async () => {
    const acquired: unknown[] = [];
    const adapter: SleepInhibitorAdapter = {
      acquire(pid) {
        acquired.push(pid);
      },
    };
    const missing = await acquireChildSleepInhibitor(undefined, adapter);
    const infinite = await acquireChildSleepInhibitor(Infinity, adapter);
    const nonNumeric = await acquireChildSleepInhibitor("123", adapter);
    await missing.release();
    await infinite.release();
    await nonNumeric.release();
    expect(acquired).toEqual([]);
  });
  test("unsupported, failed, and non-object acquisitions degrade to no-op handles", async () => {
    const unsupported = await acquireChildSleepInhibitor(303, {
      supported() {
        return false;
      },
      acquire() {
        throw new Error("must not acquire");
      },
    });
    const failed = await acquireChildSleepInhibitor(404, {
      acquire() {
        throw new Error("helper unavailable");
      },
    });
    const nonObject = await acquireChildSleepInhibitor(405, {
      acquire() {
        return "not a handle";
      },
    });
    await unsupported.release();
    await failed.release();
    await nonObject.release();
  });
  test("repeated release and release failures stay silent", async () => {
    let releaseCalls = 0;
    const handle = await acquireChildSleepInhibitor(505, {
      acquire() {
        return {
          release() {
            releaseCalls += 1;
            throw new Error("already ended");
          },
        };
      },
    });
    await handle.release();
    await handle.release();
    expect(releaseCalls).toBe(1);
  });
});

describe("makeHostSleepInhibitorAdapter", () => {
  test("linux support preserves the termination module runtime export surface", () => {
    expect(Object.keys(terminationModule).sort()).toEqual([
      "acquireChildSleepInhibitor",
      "getProcessTreeSpawnOptions",
      "isFinitePid",
      "makeHostSleepInhibitorAdapter",
      "terminateChildProcess",
    ]);
  });
  test("win32 support returns true without command lookup", async () => {
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "win32",
      async commandExists(command) {
        throw new Error(`must not check ${command}`);
      },
    });
    expect(await adapter.supported?.()).toBe(true);
  });
  test("win32 acquisition builds the deterministic PowerShell helper command", async () => {
    const spawned: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; detached: true };
    }> = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper(command, args, options) {
        spawned.push({ command, args, options });
        return { exitCode: null, signalCode: null, unref() {}, kill() {} };
      },
    });
    await (await acquireChildSleepInhibitor(606, adapter)).release();
    const script = spawned[0]?.args[2] ?? "";
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({
      command: "powershell.exe",
      args: ["-NonInteractive", "-Command", script],
      options: { stdio: "ignore", detached: true },
    });
    expect(script).toContain(
      "Add-Type -Namespace PiSubagent -Name NativeMethods",
    );
    expect(script).toContain("SetThreadExecutionState(uint esFlags)");
    expect(script.indexOf("0x80000001")).toBeLessThan(
      script.indexOf("Get-Process -Id 606"),
    );
    expect(script.indexOf("Get-Process -Id 606")).toBeLessThan(
      script.indexOf("0x80000000"),
    );
  });
  test("win32 helper interpolates finite PIDs only as numeric literals", async () => {
    const scripts: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper(_command, args) {
        scripts.push(args[2] ?? "");
        return { exitCode: null, signalCode: null, unref() {}, kill() {} };
      },
    });
    for (const pid of [0, -7, 42])
      await (await acquireChildSleepInhibitor(pid, adapter)).release();
    expect(
      scripts.map((script) => script.match(/Get-Process -Id (-?\d+)/)?.[1]),
    ).toEqual(["0", "-7", "42"]);
    expect(scripts.some((script) => /Get-Process -Id ['"]/.test(script))).toBe(
      false,
    );
  });
  test("win32 invalid PIDs never reach adapter acquisition or scripts", async () => {
    const acquired: unknown[] = [];
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper(_command, args) {
        spawned.push(args[2] ?? "");
        return { exitCode: null, signalCode: null, unref() {}, kill() {} };
      },
    });
    const rejectingAdapter: SleepInhibitorAdapter = {
      acquire(pid) {
        acquired.push(pid);
        return {};
      },
    };
    for (const pid of [undefined, "606", Number.NaN, Infinity, -Infinity]) {
      await (await acquireChildSleepInhibitor(pid, adapter)).release();
      await (await acquireChildSleepInhibitor(pid, rejectingAdapter)).release();
    }
    expect(spawned).toEqual([]);
    expect(acquired).toEqual([]);
  });
  test("win32 active helpers receive one release signal through idempotent handles", async () => {
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    const helper: SleepInhibitorHelperProcess = {
      exitCode: null,
      signalCode: null,
      unref() {},
      kill(signal?: NodeJS.Signals | number) {
        killSignals.push(signal);
        return true;
      },
    };
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper() {
        return helper;
      },
    });
    const handle = await acquireChildSleepInhibitor(607, adapter);
    await handle.release();
    await handle.release();
    expect(killSignals).toEqual(["SIGTERM"]);
  });
  test("win32 startup, event, script, early exit, and release failures stay silent", async () => {
    const startupFailure = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper() {
        throw new Error("powershell spawn failed");
      },
    });
    let emittedHelper: EventEmitter | undefined;
    const runtimeFailure = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper() {
        const helper = new EventEmitter() as EventEmitter & {
          exitCode: number | null;
          signalCode: string | null;
          killSignals: Array<NodeJS.Signals | number | undefined>;
          kill: (signal?: NodeJS.Signals | number) => boolean;
          unref: () => void;
        };
        helper.exitCode = null;
        helper.signalCode = null;
        helper.killSignals = [];
        helper.kill = (signal) => {
          helper.killSignals.push(signal);
          return true;
        };
        helper.unref = () => {};
        emittedHelper = helper;
        return helper;
      },
    });
    const signaledBeforeRelease = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper() {
        return {
          exitCode: null,
          signalCode: "SIGTERM",
          kill() {
            throw new Error("runtime-failed helper must not be killed");
          },
        };
      },
    });
    await (await acquireChildSleepInhibitor(613, startupFailure)).release();
    const runtimeHandle = await acquireChildSleepInhibitor(614, runtimeFailure);
    expect(() =>
      emittedHelper?.emit("error", new Error("Add-Type failed")),
    ).not.toThrow();
    await runtimeHandle.release();
    await (
      await acquireChildSleepInhibitor(615, signaledBeforeRelease)
    ).release();
  });
  test("win32 ended, missing-capability, and failing helpers release silently", async () => {
    const activeKillSignals: Array<NodeJS.Signals | number | undefined> = [];
    const helpers: SleepInhibitorHelperProcess[] = [
      {
        exitCode: 0,
        signalCode: null,
        kill() {
          throw new Error("exited helper must not be killed");
        },
      },
      {
        exitCode: null,
        signalCode: "SIGTERM",
        kill() {
          throw new Error("signaled helper must not be killed");
        },
      },
      {
        exitCode: null,
        signalCode: null,
      },
      {
        exitCode: null,
        signalCode: null,
        unref() {},
        kill() {
          throw new Error("release failed");
        },
      },
      {
        exitCode: null,
        signalCode: null,
        kill(signal?: NodeJS.Signals | number) {
          activeKillSignals.push(signal);
          return true;
        },
      },
    ];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "win32",
      spawnHelper() {
        const helper = helpers.shift();
        if (!helper) throw new Error("unexpected helper acquisition");
        return helper;
      },
    });
    await (await acquireChildSleepInhibitor(608, adapter)).release();
    await (await acquireChildSleepInhibitor(609, adapter)).release();
    await (await acquireChildSleepInhibitor(610, adapter)).release();
    await (await acquireChildSleepInhibitor(611, adapter)).release();
    await (await acquireChildSleepInhibitor(612, adapter)).release();
    expect(activeKillSignals).toEqual(["SIGTERM"]);
    expect(helpers).toHaveLength(0);
  });
  test("darwin support spawns a silent detached helper scoped to the child PID", async () => {
    const helper = {
      exitCode: null,
      signalCode: null,
      killSignals: [] as Array<NodeJS.Signals | number | undefined>,
      unrefCalls: 0,
      kill(signal?: NodeJS.Signals | number) {
        helper.killSignals.push(signal);
        return true;
      },
      unref() {
        helper.unrefCalls += 1;
      },
    };
    const checkedCommands: string[] = [];
    const spawned: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; detached: true };
    }> = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists(command) {
        checkedCommands.push(command);
        return command === "caffeinate";
      },
      spawnHelper(command, args, options) {
        spawned.push({ command, args, options });
        return helper;
      },
    });
    expect(await adapter.supported?.()).toBe(true);
    const handle = await acquireChildSleepInhibitor(606, adapter);
    await handle.release();
    await handle.release();
    expect(checkedCommands).toEqual(["caffeinate", "caffeinate"]);
    expect(spawned).toEqual([
      {
        command: "caffeinate",
        args: ["-dimsu", "-w", "606"],
        options: { stdio: "ignore", detached: true },
      },
    ]);
    expect(helper.unrefCalls).toBe(1);
    expect(helper.killSignals).toEqual(["SIGTERM"]);
  });
  test("linux support spawns a silent detached systemd-inhibit helper scoped to the child PID", async () => {
    const helper = new EventEmitter() as EventEmitter & {
      exitCode: null;
      signalCode: null;
      unrefCalls: number;
      killSignals: Array<NodeJS.Signals | number | undefined>;
      kill: (signal?: NodeJS.Signals | number) => boolean;
      unref: () => void;
    };
    helper.exitCode = null;
    helper.signalCode = null;
    helper.unrefCalls = 0;
    helper.killSignals = [];
    helper.kill = (signal) => {
      helper.killSignals.push(signal);
      return true;
    };
    helper.unref = () => {
      helper.unrefCalls += 1;
    };
    const checkedCommands: string[] = [];
    const spawned: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; detached: true };
    }> = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: {},
      async commandExists(command) {
        checkedCommands.push(command);
        return command === "systemd-inhibit";
      },
      spawnHelper(command, args, options) {
        spawned.push({ command, args, options });
        return helper;
      },
    });
    expect(await adapter.supported?.()).toBe(true);
    const handle = await acquireChildSleepInhibitor(707, adapter);
    expect(() =>
      helper.emit("error", new Error("helper failed")),
    ).not.toThrow();
    await handle.release();
    expect(checkedCommands).toEqual([
      "systemd-inhibit",
      "systemd-inhibit",
      "systemd-inhibit",
    ]);
    expect(spawned).toEqual([
      {
        command: "systemd-inhibit",
        args: [
          "--what=sleep:idle",
          "--who=pi-subagent",
          "--why=subagent running",
          "--mode=block",
          "/bin/sh",
          "-c",
          'while kill -0 707 2>/dev/null && [ "$(cut -d\' \' -f4 /proc/$$/stat 2>/dev/null)" != "1" ]; do sleep 1; done',
        ],
        options: { stdio: "ignore", detached: true },
      },
    ]);
    expect(helper.unrefCalls).toBe(1);
    expect(helper.killSignals).toEqual(["SIGTERM"]);
  });
  test("gnome compatible linux sessions spawn a silent detached session inhibitor scoped to the child PID", async () => {
    const cases = ["GNOME", "ubuntu:GNOME"];
    for (const desktop of cases) {
      const helper = new EventEmitter() as EventEmitter & {
        exitCode: null;
        signalCode: null;
        unrefCalls: number;
        killSignals: Array<NodeJS.Signals | number | undefined>;
        kill: (signal?: NodeJS.Signals | number) => boolean;
        unref: () => void;
      };
      helper.exitCode = null;
      helper.signalCode = null;
      helper.unrefCalls = 0;
      helper.killSignals = [];
      helper.kill = (signal) => {
        helper.killSignals.push(signal);
        return true;
      };
      helper.unref = () => {
        helper.unrefCalls += 1;
      };
      const checkedCommands: string[] = [];
      const spawned: Array<{
        command: string;
        args: string[];
        options: { stdio: "ignore"; detached: true };
      }> = [];
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "linux",
        environment: { XDG_CURRENT_DESKTOP: desktop },
        async commandExists(command) {
          checkedCommands.push(command);
          return command === "gnome-session-inhibit";
        },
        spawnHelper(command, args, options) {
          spawned.push({ command, args, options });
          return helper;
        },
      });
      const handle = await acquireChildSleepInhibitor(717, adapter);
      expect(() =>
        helper.emit("error", new Error("authorization failure")),
      ).not.toThrow();
      await handle.release();
      expect(checkedCommands).toContain("gnome-session-inhibit");
      expect(spawned).toEqual([
        {
          command: "gnome-session-inhibit",
          args: [
            "--app-id=pi-subagent",
            "--inhibit=suspend:idle",
            "--reason=subagent running",
            "/bin/sh",
            "-c",
            'while kill -0 717 2>/dev/null && [ "$(cut -d\' \' -f4 /proc/$$/stat 2>/dev/null)" != "1" ]; do sleep 1; done',
          ],
          options: { stdio: "ignore", detached: true },
        },
      ]);
      expect(helper.unrefCalls).toBe(1);
      expect(helper.killSignals).toEqual(["SIGTERM"]);
    }
  });
  test("gnome desktop falls back to systemd-inhibit when gnome-session-inhibit is unavailable", async () => {
    const killSignals = new Map<
      string,
      Array<NodeJS.Signals | number | undefined>
    >([["systemd-inhibit", []]]);
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
      commandExists(command) {
        return killSignals.has(command);
      },
      spawnHelper(command) {
        spawned.push(command);
        return {
          exitCode: null,
          signalCode: null,
          kill(signal?: NodeJS.Signals | number) {
            killSignals.get(command)?.push(signal);
            return true;
          },
        };
      },
    });
    const handle = await acquireChildSleepInhibitor(731, adapter);
    await handle.release();
    await handle.release();
    expect(spawned).toEqual(["systemd-inhibit"]);
    expect([...killSignals.values()]).toEqual([["SIGTERM"]]);
  });
  test("kde plasma linux sessions spawn a silent detached inhibitor scoped to the child PID", async () => {
    const cases = ["KDE", "plasma:KDE"];
    for (const desktop of cases) {
      const helper = new EventEmitter() as EventEmitter & {
        exitCode: null;
        signalCode: null;
        unrefCalls: number;
        killSignals: Array<NodeJS.Signals | number | undefined>;
        kill: (signal?: NodeJS.Signals | number) => boolean;
        unref: () => void;
      };
      helper.exitCode = null;
      helper.signalCode = null;
      helper.unrefCalls = 0;
      helper.killSignals = [];
      helper.kill = (signal) => {
        helper.killSignals.push(signal);
        return true;
      };
      helper.unref = () => {
        helper.unrefCalls += 1;
      };
      const checkedCommands: string[] = [];
      const spawned: Array<{
        command: string;
        args: string[];
        options: { stdio: "ignore"; detached: true };
      }> = [];
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "linux",
        environment: { XDG_CURRENT_DESKTOP: desktop },
        async commandExists(command) {
          checkedCommands.push(command);
          return command === "kde-inhibit";
        },
        spawnHelper(command, args, options) {
          spawned.push({ command, args, options });
          return helper;
        },
      });
      const handle = await acquireChildSleepInhibitor(727, adapter);
      expect(() =>
        helper.emit("error", new Error("authorization failure")),
      ).not.toThrow();
      await handle.release();
      expect(checkedCommands).toContain("kde-inhibit");
      expect(spawned).toEqual([
        {
          command: "kde-inhibit",
          args: [
            "--power",
            "--screenSaver",
            "/bin/sh",
            "-c",
            'while kill -0 727 2>/dev/null && [ "$(cut -d\' \' -f4 /proc/$$/stat 2>/dev/null)" != "1" ]; do sleep 1; done',
          ],
          options: { stdio: "ignore", detached: true },
        },
      ]);
      expect(helper.unrefCalls).toBe(1);
      expect(helper.killSignals).toEqual(["SIGTERM"]);
    }
  });
  test("kde linux acquisition degrades on missing commands and spawn failures", async () => {
    const systemdSpawned: string[] = [];
    const fallbackAdapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "KDE" },
      commandExists(command) {
        return command === "systemd-inhibit";
      },
      spawnHelper(command) {
        systemdSpawned.push(command);
        return { exitCode: null, signalCode: null };
      },
    });
    const failingAdapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "KDE" },
      commandExists(command) {
        return command === "kde-inhibit";
      },
      spawnHelper() {
        throw new Error("authorization denied");
      },
    });
    await (await acquireChildSleepInhibitor(728, fallbackAdapter)).release();
    await (await acquireChildSleepInhibitor(729, failingAdapter)).release();
    expect(systemdSpawned).toEqual(["systemd-inhibit"]);
  });
  test("kde desktop falls back to systemd-inhibit when kde-inhibit is unavailable", async () => {
    const helpers = [
      {
        command: "systemd-inhibit",
        killSignals: [] as Array<NodeJS.Signals | number | undefined>,
      },
    ];
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "plasma KDE" },
      commandExists(command) {
        return helpers.some((helper) => helper.command === command);
      },
      spawnHelper(command) {
        spawned.push(command);
        const helper = helpers.find(
          (candidate) => candidate.command === command,
        );
        if (!helper) throw new Error("unexpected helper");
        return {
          exitCode: null,
          signalCode: null,
          kill(signal?: NodeJS.Signals | number) {
            helper.killSignals.push(signal);
            return true;
          },
        };
      },
    });
    const handle = await acquireChildSleepInhibitor(730, adapter);
    await handle.release();
    await handle.release();
    expect(spawned).toEqual(["systemd-inhibit"]);
    expect(helpers.map((helper) => helper.killSignals)).toEqual([["SIGTERM"]]);
  });
  test("concurrent linux acquisitions keep multiple helper handles independent", async () => {
    const helperSignals = new Map<
      string,
      Array<NodeJS.Signals | number | undefined>
    >();
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "GNOME" },
      commandExists(command) {
        return command === "systemd-inhibit";
      },
      spawnHelper(command, args) {
        const pid = args.at(-1)?.match(/kill -0 (-?\d+)/)?.[1] ?? "missing";
        const key = `${pid}:${command}`;
        spawned.push(key);
        helperSignals.set(key, []);
        return {
          exitCode: null,
          signalCode: null,
          kill(signal?: NodeJS.Signals | number) {
            helperSignals.get(key)?.push(signal);
            return true;
          },
        };
      },
    });
    const first = await acquireChildSleepInhibitor(801, adapter);
    const second = await acquireChildSleepInhibitor(802, adapter);
    await first.release();
    expect(Object.fromEntries(helperSignals)).toEqual({
      "801:systemd-inhibit": ["SIGTERM"],
      "802:systemd-inhibit": [],
    });
    await second.release();
    await second.release();
    expect(spawned).toEqual(["801:systemd-inhibit", "802:systemd-inhibit"]);
    expect(Object.fromEntries(helperSignals)).toEqual({
      "801:systemd-inhibit": ["SIGTERM"],
      "802:systemd-inhibit": ["SIGTERM"],
    });
  });
  test("gnome linux acquisition isolates missing commands and spawn failures", async () => {
    const systemdSpawned: string[] = [];
    const fallbackAdapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "GNOME" },
      commandExists(command) {
        return command === "systemd-inhibit";
      },
      spawnHelper(command) {
        systemdSpawned.push(command);
        return { exitCode: null, signalCode: null };
      },
    });
    const isolatedSpawnFailures: string[] = [];
    const failingDesktopAdapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "GNOME" },
      commandExists(command) {
        return (
          command === "gnome-session-inhibit" || command === "systemd-inhibit"
        );
      },
      spawnHelper(command) {
        isolatedSpawnFailures.push(command);
        if (command === "gnome-session-inhibit")
          throw new Error("polkit denied");
        return { exitCode: null, signalCode: null };
      },
    });
    await (await acquireChildSleepInhibitor(718, fallbackAdapter)).release();
    await (
      await acquireChildSleepInhibitor(719, failingDesktopAdapter)
    ).release();
    expect(systemdSpawned).toEqual(["systemd-inhibit"]);
    expect(isolatedSpawnFailures).toEqual(["gnome-session-inhibit"]);
  });
  test("linux support accepts independent desktop inhibitor capabilities", async () => {
    const cases = [
      { desktop: "GNOME", command: "gnome-session-inhibit" },
      { desktop: "ubuntu:GNOME", command: "gnome-session-inhibit" },
      { desktop: "plasma KDE", command: "kde-inhibit" },
      { desktop: "KDE:GNOME", command: "gnome-session-inhibit" },
    ];
    for (const { desktop, command } of cases) {
      const checkedCommands: string[] = [];
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "linux",
        environment: { XDG_CURRENT_DESKTOP: desktop },
        async commandExists(candidate) {
          checkedCommands.push(candidate);
          return candidate === command;
        },
      });
      expect(await adapter.supported?.()).toBe(true);
      expect(checkedCommands).toContain(command);
    }
  });
  test("linux support rejects missing commands, unsupported desktops, and detection errors", async () => {
    const emptyDesktop = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "" },
      async commandExists(command) {
        return command === "gnome-session-inhibit";
      },
    });
    const throwingDesktop = makeHostSleepInhibitorAdapter({
      platform: "linux",
      getEnvironment() {
        throw new Error("desktop unavailable");
      },
      async commandExists() {
        return false;
      },
    });
    const throwingCommand = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: { XDG_CURRENT_DESKTOP: "GNOME" },
      async commandExists() {
        throw new Error("path unavailable");
      },
    });
    expect(await emptyDesktop.supported?.()).toBe(false);
    expect(await throwingDesktop.supported?.()).toBe(false);
    expect(await throwingCommand.supported?.()).toBe(false);
  });
  test("linux helper release handles active, completed, missing, throwing, and repeated kill paths", async () => {
    const activeKillSignals: Array<NodeJS.Signals | number | undefined> = [];
    const helpers: SleepInhibitorHelperProcess[] = [
      {
        exitCode: null,
        signalCode: null,
        kill(signal?: NodeJS.Signals | number) {
          activeKillSignals.push(signal);
          return true;
        },
      },
      {
        exitCode: 0,
        signalCode: null,
        kill() {
          throw new Error("exited helper must not be killed");
        },
      },
      {
        exitCode: null,
        signalCode: "SIGTERM",
        kill() {
          throw new Error("signaled helper must not be killed");
        },
      },
      {
        exitCode: null,
        signalCode: null,
      },
      {
        exitCode: null,
        signalCode: null,
        kill() {
          throw new Error("release failed");
        },
      },
    ];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: {},
      async commandExists() {
        return true;
      },
      spawnHelper() {
        const helper = helpers.shift();
        if (!helper) throw new Error("unexpected helper acquisition");
        return helper;
      },
    });
    const active = await acquireChildSleepInhibitor(708, adapter);
    await active.release();
    await active.release();
    await (await acquireChildSleepInhibitor(709, adapter)).release();
    await (await acquireChildSleepInhibitor(710, adapter)).release();
    await (await acquireChildSleepInhibitor(711, adapter)).release();
    await (await acquireChildSleepInhibitor(712, adapter)).release();
    expect(activeKillSignals).toEqual(["SIGTERM"]);
    expect(helpers).toHaveLength(0);
  });
  test("unsupported hosts and missing helper capability stay no-op", async () => {
    const spawned: string[] = [];
    const unsupported = makeHostSleepInhibitorAdapter({
      platform: "freebsd",
      async commandExists(command) {
        throw new Error(`must not check ${command}`);
      },
      spawnHelper(command) {
        spawned.push(command);
        throw new Error("must not spawn");
      },
    });
    const missingDarwinCapability = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists(command) {
        return command !== "caffeinate";
      },
      spawnHelper(command) {
        spawned.push(command);
        throw new Error("must not spawn");
      },
    });
    const missingLinuxCapability = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: {},
      async commandExists(command) {
        return command !== "systemd-inhibit";
      },
      spawnHelper(command) {
        spawned.push(command);
        throw new Error("must not spawn");
      },
    });
    expect(await unsupported.supported?.()).toBe(false);
    expect(await missingDarwinCapability.supported?.()).toBe(false);
    expect(await missingLinuxCapability.supported?.()).toBe(false);
    await (await acquireChildSleepInhibitor(808, unsupported)).release();
    await (
      await acquireChildSleepInhibitor(909, missingDarwinCapability)
    ).release();
    await (
      await acquireChildSleepInhibitor(1001, missingLinuxCapability)
    ).release();
    expect(spawned).toEqual([]);
  });
  test("unsupported platform acquire returns empty object without spawning", async () => {
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "freebsd",
      spawnHelper(command) {
        spawned.push(command);
        throw new Error("must not spawn");
      },
    });
    const handle = adapter.acquire(123);
    expect(handle).toEqual({});
    expect(spawned).toEqual([]);
  });
  test("linux acquisition tolerates missing unref and rejects invalid PIDs before spawning", async () => {
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "linux",
      environment: {},
      async commandExists() {
        return true;
      },
      spawnHelper(command) {
        spawned.push(command);
        return { exitCode: null, signalCode: null };
      },
    });
    await (await acquireChildSleepInhibitor(Number.NaN, adapter)).release();
    await (await acquireChildSleepInhibitor("707", adapter)).release();
    await (await acquireChildSleepInhibitor(808, adapter)).release();
    expect(spawned).toEqual(["systemd-inhibit"]);
  });
  test("adapter without supported method delegates directly to acquire", async () => {
    const acquired: number[] = [];
    const adapter = {
      acquire(pid: number) {
        acquired.push(pid);
        return { release() {} };
      },
    } as unknown as SleepInhibitorAdapter;
    const handle = await acquireChildSleepInhibitor(111, adapter);
    await handle.release();
    expect(acquired).toEqual([111]);
  });
  test("helper with no kill method handles release gracefully", async () => {
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        return {
          exitCode: null,
          signalCode: null,
          unref() {},
        } as unknown as SleepInhibitorHelperProcess;
      },
    });
    const handle = await acquireChildSleepInhibitor(222, adapter);
    await handle.release();
  });
  test("startup, async helper errors, release, and already-ended helpers degrade silently", async () => {
    const startupFailure = makeHostSleepInhibitorAdapter({
      platform: "linux",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        throw new Error("spawn failed");
      },
    });
    const releaseFailure = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        return {
          exitCode: null,
          signalCode: null,
          unref() {},
          kill() {
            throw new Error("release failed");
          },
        };
      },
    });
    let emittedHelper: EventEmitter | undefined;
    const asyncHelperError = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        const helper = new EventEmitter() as EventEmitter & {
          exitCode: null;
          signalCode: null;
          unref: () => void;
          kill: () => void;
        };
        helper.exitCode = null;
        helper.signalCode = null;
        helper.unref = () => {};
        helper.kill = () => {};
        emittedHelper = helper;
        return helper;
      },
    });
    const alreadyEnded = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        return {
          exitCode: 0,
          signalCode: null,
          unref() {},
          kill() {
            throw new Error("must not kill ended helper");
          },
        };
      },
    });
    await (await acquireChildSleepInhibitor(909, startupFailure)).release();
    await (await acquireChildSleepInhibitor(1001, releaseFailure)).release();
    const asyncHandle = await acquireChildSleepInhibitor(
      1002,
      asyncHelperError,
    );
    expect(() =>
      emittedHelper?.emit("error", new Error("helper failed")),
    ).not.toThrow();
    await asyncHandle.release();
    await (await acquireChildSleepInhibitor(1003, alreadyEnded)).release();
  });
  test("default commandExists uses real filesystem access", async () => {
    const spawned: string[] = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      spawnHelper(command) {
        spawned.push(command);
        return { exitCode: null, signalCode: null, unref() {}, kill() {} };
      },
    });
    const supported = await adapter.supported?.();
    if (supported) {
      await (await acquireChildSleepInhibitor(505, adapter)).release();
      expect(spawned).toEqual(["caffeinate"]);
    } else {
      await (await acquireChildSleepInhibitor(505, adapter)).release();
      expect(spawned).toEqual([]);
    }
  });
});

describe("isFinitePid", () => {
  test("accepts positive integers", () => {
    expect(isFinitePid(1)).toBe(true);
    expect(isFinitePid(99999)).toBe(true);
  });
  test("accepts zero", () => {
    expect(isFinitePid(0)).toBe(true);
  });
  test("accepts negative integers", () => {
    expect(isFinitePid(-1)).toBe(true);
  });
  test("rejects non-number types", () => {
    expect(isFinitePid(undefined)).toBe(false);
    expect(isFinitePid(null)).toBe(false);
    expect(isFinitePid("123")).toBe(false);
    expect(isFinitePid(true)).toBe(false);
    expect(isFinitePid({})).toBe(false);
  });
  test("rejects non-finite numbers", () => {
    expect(isFinitePid(Infinity)).toBe(false);
    expect(isFinitePid(-Infinity)).toBe(false);
    expect(isFinitePid(Number.NaN)).toBe(false);
  });
});

describe("getProcessTreeSpawnOptions", () => {
  test("detaches only POSIX tree spawns", () => {
    expect(getProcessTreeSpawnOptions(true, "linux")).toEqual({
      detached: true,
    });
    expect(getProcessTreeSpawnOptions(true, "win32")).toEqual({});
    expect(getProcessTreeSpawnOptions(false, "linux")).toEqual({});
  });
});

describe("terminateChildProcess", () => {
  test("sends SIGTERM before SIGKILL", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit", null, "SIGKILL");
    const metadata = await promise;
    expect(metadata.escalated).toBe(true);
    expect(metadata.terminationSignal).toBe("SIGKILL");
  });
  test("escalates after requested timeout", () => {
    const child = makeChild();
    let timeout = 0;
    const timers = makeTimers();
    void terminateChildProcess(child as unknown as ChildProcess, {
      timeoutMs: 12,
      setTimeout(callback, ms) {
        timeout = ms;
        return timers.setTimeout(callback, ms);
      },
    });
    expect(timeout).toBe(12);
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("keeps pending child cancellable after SIGTERM marks it killed", () => {
    const child = makeChild();
    child.kill = (signal) => {
      child.killed = true;
      child.signals.push(signal as TerminationSignal);
      return true;
    };
    const timers = makeTimers();
    void terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
    });
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("repeated calls reuse state and do not re-arm timers", () => {
    const child = makeChild();
    const timers = makeTimers();
    const first = terminateChildProcess(child as unknown as ChildProcess, {
      reason: "first",
      setTimeout: timers.setTimeout,
    });
    const second = terminateChildProcess(child as unknown as ChildProcess, {
      reason: "second",
      setTimeout: timers.setTimeout,
    });
    expect(first).toBe(second);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(timers.timers).toHaveLength(1);
  });
  test("already-exited child settles without signals", async () => {
    const child = makeChild({ exitCode: 0 });
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
    );
    expect(child.signals).toEqual([]);
    expect(metadata.terminationSignal).toBeUndefined();
    expect(metadata.target).toBe("direct");
  });
  // sendTreeSignal "missing child PID" throw (line 305) unreachable
  // through public API: sendTerminationSignal guards with hasPid()
  // before calling sendTreeSignal. See "settles when PID disappears".
  test("missing PID settles without signals", async () => {
    const child = makeChild();
    delete child.pid;
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
    );
    expect(child.signals).toEqual([]);
    expect(metadata.terminationSignal).toBeUndefined();
  });
  test("cleans timer when child exits", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    child.emit("close", 0, null);
    await promise;
    expect(timers.cleared).toHaveLength(1);
  });
  test("signals POSIX detached process group with negative PID", async () => {
    const child = makeChild({ pid: 456 });
    const targets: Array<[number, TerminationSignal]> = [];
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      processTreeDetached: true,
      killProcessGroup(pid, signal) {
        targets.push([pid, signal]);
      },
    });
    expect(targets).toEqual([[-456, "SIGTERM"]]);
    expect(child.signals).toEqual([]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.target).toBe("tree");
    expect(metadata.processTreeKilled).toBe(true);
    expect(metadata.terminationSignal).toBe("SIGTERM");
    expect(metadata.escalated).toBe(false);
    expect(metadata.fallbackCause).toBeUndefined();
  });
  test("falls back to direct signal when POSIX tree lacks detached group", async () => {
    const child = makeChild({ pid: 789 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.fallbackCause).toBe("process tree not detached");
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
  });
  test("settles when tree fallback direct signal fails", async () => {
    const child = makeChild({ pid: 790 });
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
      {
        tree: true,
        platform: "linux",
        killProcess() {
          throw new Error("direct kill failed");
        },
      },
    );
    expect(metadata.fallbackCause).toBe("process tree not detached");
    expect(metadata.target).toBe("tree");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
  });
  test("runs Windows taskkill command during forceful tree escalation", async () => {
    const child = makeChild({ pid: 321 });
    const timers = makeTimers();
    const taskkillArgs: string[][] = [];
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
      setTimeout: timers.setTimeout,
      runTaskkill(args) {
        taskkillArgs.push(args);
      },
    });
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(taskkillArgs).toEqual([["/pid", "321", "/t", "/f"]]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.target).toBe("tree");
    expect(metadata.processTreeKilled).toBe(true);
    expect(metadata.terminationSignal).toBe("SIGKILL");
    expect(metadata.escalated).toBe(true);
    expect(metadata.fallbackCause).toBe(
      "unsupported tree termination platform",
    );
  });
  test("uses injected process tree killer before scheduling escalation", async () => {
    const child = makeChild({ pid: 432 });
    const killed: Array<{
      platform: NodeJS.Platform;
      signal: TerminationSignal;
    }> = [];
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      killProcessTree(_child, signal, platform) {
        killed.push({ platform, signal });
      },
    });
    child.emit("exit");
    const metadata = await promise;
    expect(killed).toEqual([{ platform: "linux", signal: "SIGTERM" }]);
    expect(metadata.target).toBe("tree");
    expect(metadata.processTreeKilled).toBe(true);
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
    expect(metadata.fallbackCause).toBeUndefined();
  });
  test("settles escalation when PID disappears before timeout", async () => {
    const child = makeChild({ pid: 876 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
    });
    delete child.pid;
    timers.timers[0]?.();
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.escalated).toBe(true);
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
    expect(metadata.fallbackCause).toBeUndefined();
  });
  test("settles when child exits before timeout escalation", async () => {
    const child = makeChild({ pid: 987 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
    });
    child.exitCode = 0;
    timers.timers[0]?.();
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.escalated).toBe(false);
  });
  test("falls back to direct signal when Windows taskkill fails", async () => {
    const child = makeChild({ pid: 654 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
      setTimeout: timers.setTimeout,
      runTaskkill() {
        throw new Error("taskkill failed");
      },
    });
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.fallbackCause).toBe("taskkill failed");
    expect(metadata.escalated).toBe(true);
    expect(metadata.terminationSignal).toBe("SIGKILL");
  });
  test("win32 SIGTERM tree falls back to direct signal", async () => {
    const child = makeChild({ pid: 555 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
    });
    child.emit("exit");
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.fallbackCause).toBe(
      "unsupported tree termination platform",
    );
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
  });
  test("settles via signalCode when exitCode is null", async () => {
    const child = makeChild();
    child.signalCode = "SIGTERM";
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
    );
    expect(child.signals).toEqual([]);
    expect(metadata.terminationSignal).toBeUndefined();
  });
  test("error event settles the termination state", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    child.emit("error", new Error("spawn failed"));
    const metadata = await promise;
    expect(metadata.escalated).toBe(false);
    expect(timers.cleared).toHaveLength(1);
  });
  test("double settle is idempotent", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const metadata = await promise;
    expect(metadata.escalated).toBe(false);
  });
  test("timer unrefs when handle supports it", () => {
    const child = makeChild();
    const unrefed: unknown[] = [];
    const fakeTimer = {
      unref() {
        unrefed.push(true);
      },
    };
    void terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout() {
        return fakeTimer;
      },
    });
    expect(unrefed).toHaveLength(1);
  });
  test("tolerates timer handle without unref method", () => {
    const child = makeChild();
    const plainTimer = Symbol("timer");
    void terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout() {
        return plainTimer;
      },
    });
  });
  test("uses default killProcessGroup for POSIX detached tree", async () => {
    const child = makeChild({ pid: 99999 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      processTreeDetached: true,
      setTimeout: timers.setTimeout,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.fallbackCause).toBeDefined();
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
  });
  test("falls back when Windows taskkill exits nonzero", async () => {
    const child = makeChild({ pid: 99999 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
      setTimeout: timers.setTimeout,
      runTaskkill() {
        return { exitCode: 1 };
      },
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.escalated).toBe(true);
    expect(metadata.fallbackCause).toBe("taskkill exited with code 1");
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGKILL");
  });
  test("falls back to direct when injected killProcessTree throws", async () => {
    const child = makeChild({ pid: 444 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      killProcessTree() {
        throw new Error("tree killer failed");
      },
    });
    child.emit("exit");
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.fallbackCause).toBe("tree killer failed");
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
  });
  test("uses default fallbackCause for non-Error tree kill failures", async () => {
    const child = makeChild({ pid: 556 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      killProcessTree() {
        throw "string error";
      },
    });
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.fallbackCause).toBe("tree termination failed");
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
  });
  test("populates cancelRequestedAt and cancelReason in metadata", async () => {
    const child = makeChild();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      reason: "user requested",
      now: () => 42,
    });
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.cancelRequestedAt).toBe(42);
    expect(metadata.cancelReason).toBe("user requested");
    expect(metadata.target).toBe("direct");
    expect(metadata.escalated).toBe(false);
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
    expect(metadata.fallbackCause).toBeUndefined();
  });
  test("direct termination with explicit tree false and kill injection", async () => {
    const child = makeChild({ pid: 111 });
    const killed: TerminationSignal[] = [];
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: false,
      platform: "linux",
      reason: "explicit",
      killProcess(_proc, signal) {
        killed.push(signal);
      },
    });
    expect(killed).toEqual(["SIGTERM"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.cancelReason).toBe("explicit");
    expect(metadata.escalated).toBe(false);
    expect(metadata.terminationSignal).toBe("SIGTERM");
    expect(metadata.fallbackCause).toBeUndefined();
  });
});
