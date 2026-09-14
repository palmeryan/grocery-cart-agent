import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  launchOwnedChrome,
  listProfileProcessIds,
} from "../src/browser.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

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
});

describe("owned Chrome lifecycle", () => {
  it("refuses a profile already used before launch", async () => {
    await expect(
      launchOwnedChrome({
        executable: "/Applications/Google Chrome",
        profileDir: "/profiles/wfm",
        startupTimeoutMs: 100,
        stopTimeoutMs: 100,
        listProfilePids: () => [999],
        spawnChrome: vi.fn(),
      }),
    ).rejects.toThrow("Dedicated Chrome profile is already active");
  });

  it("launches normal Chrome and stops its owned process group", async () => {
    const child = new FakeChild();
    const signals: Array<[number, NodeJS.Signals]> = [];
    let checks = 0;
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
      launchUrl: "https://www.amazon.com/wholefoods",
      spawnChrome: vi.fn(() => child),
      listProfilePids: () => (++checks === 1 ? [] : checks < 4 ? [4242] : []),
      signalGroup: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") child.emit("exit", 0, "SIGTERM");
      },
      sleep: async () => undefined,
    });
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
      now: (() => {
        let value = 0;
        return () => ++value;
      })(),
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
      now: (() => {
        let value = 0;
        return () => ++value;
      })(),
    });
    expect(await session.stop()).toEqual({
      stopped: false,
      remainingProfilePids: [4242, 5151],
    });
    expect(signaledGroups.every((pid) => pid === 4242)).toBe(true);
  });
});
