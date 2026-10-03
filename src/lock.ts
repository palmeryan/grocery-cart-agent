import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { listProfileProcessIds } from "./browser.js";

export interface RunLock {
  release(): void;
  retain(): void;
}

export interface AcquireRunLockOptions {
  profileDir?: string;
  isPidAlive?: (pid: number) => boolean;
  listProfilePids?: (profileDir: string) => number[];
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function recoverStaleLock(path: string, options: AcquireRunLockOptions): void {
  let content: string;
  let originalStat;
  try {
    originalStat = lstatSync(path);
    content = readFileSync(path, "utf8");
    const readStat = lstatSync(path);
    if (readStat.ino !== originalStat.ino || readStat.dev !== originalStat.dev) {
      throw new Error(`Cart lock at ${path} changed during stale-lock recovery; retry the command.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Could not inspect cart lock at ${path}: ${String(error)}`, { cause: error });
  }

  const match = /^(\d+)\s*$/.exec(content);
  const pid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cart lock at ${path} has invalid contents. Inspect it and remove it manually only after confirming no cart job is running.`);
  }

  let alive: boolean;
  try {
    alive = (options.isPidAlive ?? defaultIsPidAlive)(pid);
  } catch (error) {
    throw new Error(`Could not verify lock owner PID ${pid} for ${path}: ${String(error)}. Confirm the process and dedicated Chrome profile are stopped before removing the lock.`, { cause: error });
  }
  if (alive) {
    throw new Error(`A Whole Foods cart job is still running (PID ${pid}); lock: ${path}`);
  }

  if (!options.profileDir) {
    throw new Error(`Lock owner PID ${pid} is gone, but the dedicated Chrome profile was not checked. Set the profile directory or manually confirm it is stopped before removing ${path}.`);
  }
  let profilePids: number[];
  try {
    profilePids = (options.listProfilePids ?? listProfileProcessIds)(options.profileDir);
  } catch (error) {
    throw new Error(`Could not check Chrome processes using the dedicated profile: ${String(error)}. Keep ${path} in place until the profile can be checked.`, { cause: error });
  }
  if (profilePids.length > 0) {
    throw new Error(`Lock owner PID ${pid} is gone, but Chrome still uses the dedicated profile (PIDs: ${profilePids.join(", ")}). Stop those processes, then retry; lock: ${path}`);
  }

  // Avoid deleting a replacement lock written after our inspection.
  try {
    const currentStat = lstatSync(path);
    if (currentStat.ino !== originalStat.ino || currentStat.dev !== originalStat.dev) {
      throw new Error(`Cart lock at ${path} changed during stale-lock recovery; retry the command.`);
    }
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function acquireRunLock(path: string, options: AcquireRunLockOptions = {}): RunLock {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const recoveryGuard = `${path}.recovery`;
      try {
        mkdirSync(recoveryGuard, { mode: 0o700 });
      } catch (guardError) {
        if ((guardError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Cart lock recovery is already underway or its recovery guard was left at ${recoveryGuard}. Retry shortly; if it persists, confirm no recovery is running before removing the guard.`, { cause: guardError });
        }
        throw new Error(`Could not create cart lock recovery guard ${recoveryGuard}: ${String(guardError)}`, { cause: guardError });
      }
      try {
        recoverStaleLock(path, options);
        try {
          descriptor = openSync(path, "wx", 0o600);
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
          throw new Error(`A Whole Foods cart job acquired the lock at ${path} during stale-lock recovery; retry shortly.`, { cause: retryError });
        }
      } finally {
        rmdirSync(recoveryGuard);
      }
    } else {
      throw error;
    }
  }
  writeFileSync(descriptor, `${process.pid}\n`);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closeSync(descriptor);
    closed = true;
  };
  return {
    release() {
      close();
      unlinkSync(path);
    },
    retain() {
      close();
    },
  };
}
