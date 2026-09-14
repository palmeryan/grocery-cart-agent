import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserLaunchError,
  launchOwnedChrome,
  listProfileProcessIds,
} from "../src/browser.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

const advancingNow = () => {
  let value = 0;
  return () => ++value;
};

describe("profile process discovery", () => {
  it("returns only processes using the exact dedicated profile argument", () => {
    const stdout = [
      "101 /Applications/Google Chrome --user-data-dir=/profiles/wfm",
      "102 /Applications/Google Chrome --user-data-dir=/profiles/everyday",
      "103 /Applications/Google Chrome --type=renderer --user-data-dir=/profiles/wfm",
    ].join("\n");
    expect(
      listProfileProcessIds("/profiles/wfm", () => stdout),
    ).toEqual([101, 103]);
  });

  it("does not match prefix-sibling profile directories", () => {
    const stdout = [
      "201 /Applications/Google Chrome --user-data-dir=/profiles/wfm-extra",
      "202 /Applications/Google Chrome --user-data-dir=/profiles/wfm",
      "203 /Applications/Google Chrome --user-data-dir=/profiles/wfm2 --type=gpu",
    ].join("\n");
    expect(
      listProfileProcessIds("/profiles/wfm", () => stdout),
    ).toEqual([202]);
  });
});

describe("owned Chrome lifecycle", () => {
  it("refuses a profile already used before launch", async () => {
    const spawnChrome = vi.fn();
    const error = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
      listProfilePids: () => [999],
      spawnChrome,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error).toMatchObject({
      message: expect.stringContaining("Dedicated Chrome profile is already active"),
      requiresLockRetention: false,
    });
    expect(spawnChrome).not.toHaveBeenCalled();
  });

  it("launches normal Chrome and stops its owned process group", async () => {
    const child = new FakeChild();
    const signals: Array<[number, NodeJS.Signals]> = [];
    let checks = 0;
    const spawnChrome = vi.fn(() => child);
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
      launchUrl: "https://www.amazon.com/wholefoods",
      spawnChrome,
      listProfilePids: () => (++checks === 1 ? [] : checks < 4 ? [4242] : []),
      signalGroup: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") child.emit("exit", 0, "SIGTERM");
      },
      sleep: async () => undefined,
    });
    expect(spawnChrome).toHaveBeenCalledWith(
      "/Applications/Google Chrome",
      [
        "--user-data-dir=/profiles/wfm",
        "--no-first-run",
        "--no-default-browser-check",
        "https://www.amazon.com/wholefoods",
      ],
      { detached: true, stdio: "ignore" },
    );
    expect(session.pid).toBe(4242);
    await expect(session.stop()).resolves.toEqual({
      stopped: true,
      remainingProfilePids: [],
    });
    expect(signals).toEqual([[4242, "SIGTERM"]]);
  });

  it("escalates owned Chrome after the graceful timeout", async () => {
    const child = new FakeChild();
    const signals: NodeJS.Signals[] = [];
    let launched = false;
    let stopping = false;
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      spawnChrome: () => {
        launched = true;
        return child;
      },
      listProfilePids: () => {
        if (!launched) return [];
        if (stopping && signals.includes("SIGKILL")) return [];
        return [4242];
      },
      signalGroup: (_pid, signal) => {
        stopping = true;
        signals.push(signal);
      },
      sleep: async () => undefined,
      now: advancingNow(),
    });
    expect((await session.stop()).stopped).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reports remaining profile processes and never signals their PIDs", async () => {
    const child = new FakeChild();
    const signaledGroups: number[] = [];
    let launched = false;
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      spawnChrome: () => {
        launched = true;
        return child;
      },
      listProfilePids: () => (launched ? [4242, 5151] : []),
      signalGroup: (pid) => signaledGroups.push(pid),
      sleep: async () => undefined,
      now: advancingNow(),
    });
    expect(await session.stop()).toEqual({
      stopped: false,
      remainingProfilePids: [4242, 5151],
    });
    expect(signaledGroups.every((pid) => pid === 4242)).toBe(true);
  });

  it("clears profile on startup failure without lock retention", async () => {
    const child = new FakeChild();
    const signaledGroups: number[] = [];
    let launched = false;
    let stopping = false;

    const error = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      spawnChrome: () => {
        launched = true;
        return child;
      },
      // Never includes owned PID 4242 → startup fails; foreign 5151 appears until cleanup.
      listProfilePids: () => {
        if (!launched) return [];
        if (stopping) return [];
        return [5151];
      },
      signalGroup: (pid, signal) => {
        stopping = true;
        signaledGroups.push(pid);
        void signal;
      },
      sleep: async () => undefined,
      now: advancingNow(),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error).toMatchObject({
      message: "Owned Chrome failed to start",
      requiresLockRetention: false,
    });
    expect(signaledGroups.length).toBeGreaterThan(0);
    expect(signaledGroups.every((pid) => pid === 4242)).toBe(true);
    expect(signaledGroups).not.toContain(5151);
  });

  it("retains lock on startup failure when profile processes remain", async () => {
    const child = new FakeChild();
    const signaledGroups: number[] = [];
    let launched = false;

    const error = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      spawnChrome: () => {
        launched = true;
        return child;
      },
      // Owned PID never appears; foreign 5151 remains after cleanup signals.
      listProfilePids: () => (launched ? [5151] : []),
      signalGroup: (pid) => {
        signaledGroups.push(pid);
      },
      sleep: async () => undefined,
      now: advancingNow(),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error).toMatchObject({
      requiresLockRetention: true,
    });
    expect((error as BrowserLaunchError).message).toContain("5151");
    expect(signaledGroups.every((pid) => pid === 4242)).toBe(true);
    expect(signaledGroups).not.toContain(5151);
  });
});
