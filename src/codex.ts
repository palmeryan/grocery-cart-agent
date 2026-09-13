import { createWriteStream, type WriteStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
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

function signalProcessGroup(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals,
): void {
  if (!child) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // Negative PID targets the process group (detached child is group leader).
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited (ESRCH) or not killable.
    }
  }
}

export async function runCodex(input: RunCodexInput): Promise<CodexResult> {
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let events: WriteStream | undefined;
  let stderr: WriteStream | undefined;
  let child: ChildProcess | undefined;

  const clearTimers = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
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

    timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(spawned, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessGroup(spawned, "SIGKILL");
      }, killGraceMs);
    }, input.timeoutMs);

    return await new Promise<CodexResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: CodexResult): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        signalProcessGroup(spawned, "SIGKILL");
        reject(error);
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

      spawned.once("error", (error) => {
        fail(error);
      });
      spawned.once("close", (code, signal) => {
        finish({
          exitCode: code ?? 1,
          signal,
          timedOut,
        });
      });
    });
  } finally {
    clearTimers();
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
