import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
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
}

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

export async function runCodex(input: RunCodexInput): Promise<CodexResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);

  const events = createWriteStream(input.eventsPath, {
    flags: "wx",
    mode: 0o600,
  });
  const stderr = createWriteStream(input.stderrPath, {
    flags: "wx",
    mode: 0o600,
  });

  try {
    const child = spawn(input.executable, input.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: controller.signal,
    });
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);
    child.stdin.end(input.prompt);

    return await new Promise<CodexResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: CodexResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.once("error", (error) => {
        if (timedOut && error.name === "AbortError") {
          finish({ exitCode: 1, signal: null, timedOut: true });
          return;
        }
        fail(error);
      });
      child.once("close", (code, signal) => {
        finish({ exitCode: code ?? 1, signal, timedOut });
      });
    });
  } finally {
    clearTimeout(timer);
    events.end();
    stderr.end();
    await Promise.all([finished(events), finished(stderr)]);
  }
}
