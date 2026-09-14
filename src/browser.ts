import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import type {
  BrowserStopResult,
  OwnedChromeSession,
} from "./types.js";

export type ExecFileText = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] },
) => string;

type SpawnedChrome = {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (...args: unknown[]) => void): unknown;
};

type SpawnChrome = (
  executable: string,
  args: string[],
  options: {
    detached: true;
    stdio: "ignore";
  },
) => SpawnedChrome;

export interface LaunchChromeInput {
  executable: string;
  profileDir: string;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  launchUrl?: string;
  remoteDebuggingPort?: number;
  spawnChrome?: SpawnChrome;
  listProfilePids?: () => number[];
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const POLL_MS = 100;
const DEFAULT_URL = "https://www.wholefoodsmarket.com/grocery/search";

export class BrowserLaunchError extends Error {
  constructor(
    message: string,
    readonly requiresLockRetention: boolean,
  ) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}

const defaultSignalGroup = (
  pid: number,
  signal: NodeJS.Signals,
): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The owned group may already be gone; profile discovery decides safety.
  }
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultNow = (): number => Date.now();

/** Reserve a localhost port for Chrome's remote debugging endpoint. */
export async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("Could not reserve a localhost port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

const defaultSpawnChrome: SpawnChrome = (executable, args, options) =>
  spawn(executable, args, options);

export function listProfileProcessIds(
  profileDir: string,
  execFile: ExecFileText = execFileSync,
): number[] {
  const output = execFile(
    "ps",
    ["-axo", "pid=,command="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const marker = `--user-data-dir=${profileDir}`;
  return output
    .split("\n")
    .filter((line) => {
      const index = line.indexOf(marker);
      if (index < 0) {
        return false;
      }
      const after = line[index + marker.length];
      // Exact token only: end of arg, or a new CLI flag/arg separator.
      return after === undefined || after === " " || after === "\t";
    })
    .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (!predicate()) {
    if (now() >= deadline) {
      return false;
    }
    await sleep(POLL_MS);
  }
  return true;
}

async function signalOwnedGroupAndWait(
  ownedPid: number,
  listProfilePids: () => number[],
  signalGroup: (pid: number, signal: NodeJS.Signals) => void,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  timeoutMs: number,
  signal: NodeJS.Signals,
): Promise<number[]> {
  signalGroup(ownedPid, signal);
  await waitUntil(
    () => listProfilePids().length === 0,
    timeoutMs,
    sleep,
    now,
  );
  return listProfilePids();
}

export async function launchOwnedChrome(
  input: LaunchChromeInput,
): Promise<OwnedChromeSession> {
  const listProfilePids =
    input.listProfilePids ??
    (() => listProfileProcessIds(input.profileDir));
  const spawnChrome = input.spawnChrome ?? defaultSpawnChrome;
  const signalGroup = input.signalGroup ?? defaultSignalGroup;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? defaultNow;

  const existingPids = listProfilePids();
  if (existingPids.length > 0) {
    throw new BrowserLaunchError(
      `Dedicated Chrome profile is already active: ${existingPids.join(", ")}`,
      false,
    );
  }

  const args = [
    `--user-data-dir=${input.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(input.remoteDebuggingPort === undefined
      ? []
      : [`--remote-debugging-port=${input.remoteDebuggingPort}`]),
    input.launchUrl ?? DEFAULT_URL,
  ];

  const child = spawnChrome(input.executable, args, {
    detached: true,
    stdio: "ignore",
  });

  const ownedPid = child.pid;
  if (typeof ownedPid !== "number" || !Number.isInteger(ownedPid) || ownedPid <= 0) {
    throw new BrowserLaunchError(
      "Failed to launch owned Chrome: no positive child PID",
      false,
    );
  }

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    exited = true;
  }

  const started = await waitUntil(
    () => exited || listProfilePids().includes(ownedPid),
    input.startupTimeoutMs,
    sleep,
    now,
  );

  if (!started || exited || !listProfilePids().includes(ownedPid)) {
    await signalOwnedGroupAndWait(
      ownedPid,
      listProfilePids,
      signalGroup,
      sleep,
      now,
      input.stopTimeoutMs,
      "SIGTERM",
    );
    let remaining = listProfilePids();
    if (remaining.length > 0) {
      remaining = await signalOwnedGroupAndWait(
        ownedPid,
        listProfilePids,
        signalGroup,
        sleep,
        now,
        input.stopTimeoutMs,
        "SIGKILL",
      );
    }
    const requiresLockRetention = remaining.length > 0;
    const message = requiresLockRetention
      ? `Owned Chrome failed to start; profile processes still active: ${remaining.join(", ")}`
      : "Owned Chrome failed to start";
    throw new BrowserLaunchError(message, requiresLockRetention);
  }

  let stopPromise: Promise<BrowserStopResult> | null = null;

  const stop = async (): Promise<BrowserStopResult> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      let remaining = await signalOwnedGroupAndWait(
        ownedPid,
        listProfilePids,
        signalGroup,
        sleep,
        now,
        input.stopTimeoutMs,
        "SIGTERM",
      );
      if (remaining.length > 0) {
        remaining = await signalOwnedGroupAndWait(
          ownedPid,
          listProfilePids,
          signalGroup,
          sleep,
          now,
          input.stopTimeoutMs,
          "SIGKILL",
        );
      }
      return {
        stopped: remaining.length === 0,
        remainingProfilePids: remaining,
      };
    })();
    return stopPromise;
  };

  return {
    pid: ownedPid,
    ...(input.remoteDebuggingPort === undefined
      ? {}
      : { remoteDebuggingPort: input.remoteDebuggingPort }),
    stop,
  };
}
