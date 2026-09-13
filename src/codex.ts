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
      'mcp_servers.playwright.default_tools_approval_mode="auto"',
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
async function forceReapProcessGroup(pgid: number | undefined): Promise<void> {
  if (pgid === undefined) return;
  signalProcessGroup(pgid, "SIGKILL");
  if (await waitUntilGroupEmpty(pgid, POST_KILL_REAP_MS)) return;
  signalProcessGroup(pgid, "SIGKILL");
  await waitUntilGroupEmpty(pgid, POST_KILL_REAP_MS);
}

export async function runCodex(input: RunCodexInput): Promise<CodexResult> {
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let events: WriteStream | undefined;
  let stderr: WriteStream | undefined;
  let child: ChildProcess | undefined;
  let groupPid: number | undefined;
  /** Resolves only after the post-timeout SIGKILL escalation has run. */
  let killEscalation: Promise<void> | undefined;

  const clearTimeoutTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const clearKillTimer = (): void => {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
  };

  const clearTimers = (): void => {
    clearTimeoutTimer();
    clearKillTimer();
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
      let killEscalationDone = false;

      const trySettle = (): void => {
        if (settled || !closeResult) return;
        // After timeout, hold settle until SIGKILL escalation has finished.
        if (closeResult.timedOut && !killEscalationDone) return;
        settled = true;
        clearTimeoutTimer();
        resolve(closeResult);
      };

      const finishKillEscalation = (): void => {
        if (killEscalationDone) return;
        killEscalationDone = true;
        clearKillTimer();
        trySettle();
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        void forceReapProcessGroup(groupPid).finally(() => {
          reject(error);
        });
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

        // Keep SIGKILL armed for the full grace period even if the leader
        // exits on SIGTERM first. Descendants that ignore SIGTERM must still
        // be reaped before runCodex resolves.
        killEscalation = new Promise<void>((done) => {
          killTimer = setTimeout(() => {
            void forceReapProcessGroup(groupPid).finally(() => {
              finishKillEscalation();
              done();
            });
          }, killGraceMs);
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
        // Leader closed after timeout: do NOT clear killTimer.
        trySettle();
      });
    });
  } finally {
    clearTimeoutTimer();
    // Never cancel an armed kill escalation from finally before it runs;
    // await it so SIGTERM-resistant descendants are reaped first.
    if (killEscalation) {
      await killEscalation;
    } else {
      clearKillTimer();
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
