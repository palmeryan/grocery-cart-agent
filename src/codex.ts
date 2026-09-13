import { createWriteStream, type WriteStream } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { finished } from "node:stream/promises";

export interface CodexInvocationInput {
  rootDir: string;
  profileDir: string;
  browserOutputDir: string;
  reportPath: string;
  schemaPath: string;
  playwrightMcpBin: string;
}

export interface CodexInvocation {
  args: string[];
}

export interface CodexResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RunCodexInput {
  executable: string;
  args: string[];
  prompt: string;
  eventsPath: string;
  stderrPath: string;
  timeoutMs: number;
  /** SIGTERM→SIGKILL grace period after timeout (default 2000ms). */
  killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const POST_KILL_REAP_MS = 1_000;
const REAP_POLL_MS = 25;

export function buildCodexInvocation(
  input: CodexInvocationInput,
): CodexInvocation {
  const mcpArgs = [
    "--browser=chrome",
    `--user-data-dir=${input.profileDir}`,
    `--output-dir=${input.browserOutputDir}`,
    "--caps=devtools",
  ];
  return {
    args: [
      "exec",
      "--ignore-user-config",
      "--strict-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--json",
      "--output-schema",
      input.schemaPath,
      "--output-last-message",
      input.reportPath,
      "--cd",
      input.rootDir,
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.playwright.command=${JSON.stringify(input.playwrightMcpBin)}`,
      "-c",
      `mcp_servers.playwright.args=${JSON.stringify(mcpArgs)}`,
      "-c",
      "mcp_servers.playwright.enabled=true",
      "-c",
      'mcp_servers.playwright.default_tools_approval_mode="approve"',
      "-c",
      "mcp_servers.playwright.startup_timeout_sec=30",
      "-c",
      "mcp_servers.playwright.tool_timeout_sec=120",
      "-",
    ],
  };
}

function openExclusiveLog(path: string): Promise<WriteStream> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(path, {
      flags: "wx",
      mode: 0o600,
    });
    const onError = (error: Error): void => {
      stream.off("open", onOpen);
      reject(error);
    };
    const onOpen = (): void => {
      stream.off("error", onError);
      resolve(stream);
    };
    stream.once("error", onError);
    stream.once("open", onOpen);
  });
}

async function closeLog(stream: WriteStream | undefined): Promise<void> {
  if (!stream || stream.destroyed) return;
  if (!stream.writableEnded) {
    stream.end();
  }
  try {
    await finished(stream);
  } catch {
    // Ignore close/finish errors during cleanup.
  }
}

/** PIDs still alive in the process group (macOS/Linux). */
function listProcessGroupMembers(pgid: number): number[] {
  try {
    const stdout = execFileSync("pgrep", ["-g", String(pgid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function processGroupHasMembers(pgid: number): boolean {
  return listProcessGroupMembers(pgid).length > 0;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH / EPERM — already gone or not killable.
  }
}

/**
 * Signal the whole group, then every remaining member individually.
 * Needed because on macOS `kill(-pgid)` can succeed while orphaned
 * SIGTERM-resistant members remain until hit by PID.
 */
function signalProcessGroup(pgid: number | undefined, signal: NodeJS.Signals): void {
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group leader may already be dead.
  }
  for (const pid of listProcessGroupMembers(pgid)) {
    signalPid(pid, signal);
  }
}

async function waitUntilGroupEmpty(
  pgid: number,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!processGroupHasMembers(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, REAP_POLL_MS));
  }
  return !processGroupHasMembers(pgid);
}

/**
 * After the SIGTERM grace period: SIGKILL the group and every remaining
 * member, and do not return until the group is empty (within budget).
 */
export async function forceReapProcessGroup(
  pgid: number | undefined,
): Promise<void> {
  if (pgid === undefined) return;
  signalProcessGroup(pgid, "SIGKILL");
  if (await waitUntilGroupEmpty(pgid, POST_KILL_REAP_MS)) return;
  signalProcessGroup(pgid, "SIGKILL");
  await waitUntilGroupEmpty(pgid, POST_KILL_REAP_MS);
}

export interface KillEscalation {
  /** Settles only after force-reap has run (timer path or early complete). */
  readonly done: Promise<void>;
  /** True after force-reap finished via any path. */
  readonly isComplete: () => boolean;
  /**
   * Cancel the grace timer if still pending, force-reap now, and resolve
   * `done`. Idempotent — safe from fail paths and the timer callback.
   */
  readonly completeNow: () => Promise<void>;
}

export interface CreateKillEscalationOptions {
  pgid: number | undefined;
  graceMs: number;
  /** Injected for tests; defaults to forceReapProcessGroup. */
  reap?: (pgid: number | undefined) => Promise<void>;
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injected for tests; defaults to clearTimeout. */
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Shared timeout→SIGKILL coordinator.
 * Clearing the grace timer always goes through `completeNow`, which also
 * resolves `done`, so outer `finally { await done }` cannot hang.
 */
export function createKillEscalation(
  options: CreateKillEscalationOptions,
): KillEscalation {
  const reap = options.reap ?? forceReapProcessGroup;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;

  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let inFlight: Promise<void> | undefined;

  const runComplete = (): Promise<void> => {
    if (complete) return Promise.resolve();
    if (inFlight) return inFlight;
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    inFlight = Promise.resolve()
      .then(() => reap(options.pgid))
      .catch(() => {
        // Reap best-effort; always mark complete so waiters cannot hang.
      })
      .then(() => {
        complete = true;
        inFlight = undefined;
        resolveDone();
      });
    return inFlight;
  };

  timer = schedule(() => {
    void runComplete();
  }, options.graceMs);

  return {
    done,
    isComplete: () => complete,
    completeNow: runComplete,
  };
}

export async function runCodex(input: RunCodexInput): Promise<CodexResult> {
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let events: WriteStream | undefined;
  let stderr: WriteStream | undefined;
  let child: ChildProcess | undefined;
  let groupPid: number | undefined;
  let escalation: KillEscalation | undefined;

  const clearTimeoutTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  try {
    events = await openExclusiveLog(input.eventsPath);
    stderr = await openExclusiveLog(input.stderrPath);

    const spawned = spawn(input.executable, input.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // New process group so timeout can reap MCP/Chrome descendants.
      detached: true,
    });
    child = spawned;
    groupPid = spawned.pid;

    return await new Promise<CodexResult>((resolve, reject) => {
      let settled = false;
      let closeResult: CodexResult | undefined;

      const trySettle = (): void => {
        if (settled || !closeResult) return;
        // After timeout, hold settle until SIGKILL escalation has finished.
        if (closeResult.timedOut && !(escalation?.isComplete() ?? false)) {
          return;
        }
        settled = true;
        clearTimeoutTimer();
        resolve(closeResult);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeoutTimer();
        const finishFail = (): void => {
          reject(error);
        };
        if (escalation) {
          // Never clear escalation without completing its promise.
          void escalation.completeNow().finally(finishFail);
          return;
        }
        void forceReapProcessGroup(groupPid).finally(finishFail);
      };

      const onStreamError = (error: Error): void => {
        fail(error);
      };
      events!.once("error", onStreamError);
      stderr!.once("error", onStreamError);

      if (!spawned.stdout || !spawned.stderr || !spawned.stdin) {
        fail(new Error("Codex child process is missing stdio pipes"));
        return;
      }

      spawned.stdout.pipe(events!);
      spawned.stderr.pipe(stderr!);
      spawned.stdin.end(input.prompt);

      timer = setTimeout(() => {
        timedOut = true;
        if (closeResult) {
          closeResult = { ...closeResult, timedOut: true };
        }
        signalProcessGroup(groupPid, "SIGTERM");

        // Shared coordinator: timer path and fail path both complete `done`.
        escalation = createKillEscalation({
          pgid: groupPid,
          graceMs: killGraceMs,
        });
        void escalation.done.then(() => {
          trySettle();
        });

        trySettle();
      }, input.timeoutMs);

      spawned.once("error", (error) => {
        fail(error);
      });
      spawned.once("close", (code, signal) => {
        closeResult = {
          exitCode: code ?? 1,
          signal,
          timedOut,
        };
        if (!timedOut) {
          clearTimeoutTimer();
          trySettle();
          return;
        }
        // Leader closed after timeout: do NOT cancel escalation.
        trySettle();
      });
    });
  } finally {
    clearTimeoutTimer();
    // Await armed escalation so fail/timer both unblock this path.
    if (escalation) {
      await escalation.done;
    }
    if (child?.stdout && events && !events.destroyed) {
      child.stdout.unpipe(events);
    }
    if (child?.stderr && stderr && !stderr.destroyed) {
      child.stderr.unpipe(stderr);
    }
    await closeLog(events);
    await closeLog(stderr);
  }
}
