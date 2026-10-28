import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { finished } from "node:stream/promises";

/** Default model settings for reproducible agent runs. */
export const INGREDIENTS_AGENT_MODEL = "gpt-5.6-terra" as const;
export const INGREDIENTS_AGENT_REASONING_EFFORT = "medium" as const;

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CodexInvocation {
  args: string[];
  workDir: string;
}

export interface IngredientsAgentInvocationInput {
  rootDir: string;
  workDir?: string;
  outputPath: string;
  schemaPath: string;
}

export interface CodexResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RunCodexInput {
  executable: string;
  workDir?: string;
  args: string[];
  prompt: string;
  eventsPath: string;
  stderrPath: string;
  timeoutMs: number;
  /** SIGTERM→SIGKILL grace period after timeout (default 2000ms). */
  killGraceMs?: number;
  /** Optional abort signal (Ctrl-C / SIGTERM path). */
  signal?: AbortSignal;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const POST_KILL_REAP_MS = 1_000;
const REAP_POLL_MS = 25;

/** CLI version used for isolation verification; other versions warn, not fail. */
export const TESTED_CODEX_VERSION = "0.160.0";

// Each of these features can expose tools or discover/install additional tools.
const DISABLED_MODEL_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "multi_agent",
  "browser_use", "browser_use_external", "computer_use", "hooks", "image_generation",
  "view_image", "code_mode", "code_mode_host", "remote_plugin", "skill_search",
  "skill_mcp_dependency_install", "workspace_dependencies",
] as const;

/** Forward existing values only; never inherit unrelated application secrets. */
export function codexEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ];
  return Object.fromEntries(allowed.filter((key) => env[key] !== undefined)
    .map((key) => [key, env[key]]));
}

export function buildRestrictedCodexInvocation(
  input: IngredientsAgentInvocationInput & { model: string; reasoningEffort: ReasoningEffort },
): CodexInvocation {
  const outputPath = resolve(input.rootDir, input.outputPath);
  const workDir = resolve(input.workDir ?? join(dirname(outputPath), "model-work"));
  const settings = [
    'default_permissions="wfm-model"',
    'permissions.wfm-model.extends=":read-only"',
    'permissions.wfm-model.filesystem={ ":root"="deny", ":minimal"="read", ":tmpdir"="deny", ":slash_tmp"="deny", "/private/tmp"="deny" }',
    'permissions.wfm-model.network.enabled=false',
    'approval_policy="never"',
    'web_search="disabled"',
    'project_doc_max_bytes=0',
    'shell_environment_policy.inherit="none"',
    ...DISABLED_MODEL_FEATURES.map((feature) => `features.${feature}=false`),
  ];
  return {
    workDir,
    args: [
      "--no-daemon", "exec", "--model", input.model,
      "-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
      "--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral",
      "--skip-git-repo-check", "--json",
      "--output-schema", resolve(input.rootDir, input.schemaPath),
      "--output-last-message", outputPath, "--cd", workDir,
      ...settings.flatMap((setting) => ["-c", setting]), "-",
    ],
  };
}

export function buildIngredientsAgentInvocation(input: IngredientsAgentInvocationInput): CodexInvocation {
  return buildRestrictedCodexInvocation({
    ...input, model: INGREDIENTS_AGENT_MODEL, reasoningEffort: INGREDIENTS_AGENT_REASONING_EFFORT,
  });
}

const checkedExecutables = new Set<string>();
function warnOnUntestedCodex(executable: string, env: NodeJS.ProcessEnv, cwd: string): void {
  if (checkedExecutables.has(executable)) return;
  checkedExecutables.add(executable);
  let version: string | undefined;
  try {
    version = /codex-cli\s+(\S+)/.exec(execFileSync(executable, ["--version"], {
      env, cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
    }))?.[1];
  } catch { /* The real invocation will report unsupported flags or configuration. */ }
  if (version !== TESTED_CODEX_VERSION) {
    console.warn(`[security] Codex ${version ?? "version unknown"}: model isolation was tested on ${TESTED_CODEX_VERSION}. Tool removal uses individual feature switches; this version's tool inventory is unverified.`);
  }
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
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let events: WriteStream | undefined;
  let stderr: WriteStream | undefined;
  let child: ChildProcess | undefined;
  let groupPid: number | undefined;
  let escalation: KillEscalation | undefined;
  let removeAbortListener: (() => void) | undefined;

  const clearTimeoutTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const detachAbort = (): void => {
    removeAbortListener?.();
    removeAbortListener = undefined;
  };

  try {
    events = await openExclusiveLog(input.eventsPath);
    stderr = await openExclusiveLog(input.stderrPath);

    const env = codexEnvironment();
    if (input.workDir) {
      mkdirSync(input.workDir, { recursive: true, mode: 0o700 });
      warnOnUntestedCodex(input.executable, env, input.workDir);
    }
    const spawned = spawn(input.executable, input.args, {
      env,
      ...(input.workDir ? { cwd: input.workDir } : {}),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // New process group so timeout/abort can reap MCP/Chrome descendants.
      detached: true,
    });
    child = spawned;
    groupPid = spawned.pid;

    return await new Promise<CodexResult>((resolve, reject) => {
      let settled = false;
      let closeResult: CodexResult | undefined;
      let cancelRequested = false;

      const needsEscalationComplete = (): boolean =>
        Boolean(cancelRequested || timedOut || aborted);

      const trySettle = (): void => {
        if (settled || !closeResult) return;
        // After timeout/abort, hold settle until SIGKILL escalation finished.
        if (needsEscalationComplete() && !(escalation?.isComplete() ?? false)) {
          return;
        }
        settled = true;
        clearTimeoutTimer();
        detachAbort();
        resolve(closeResult);
      };

      const armEscalation = (): void => {
        if (escalation) return;
        escalation = createKillEscalation({
          pgid: groupPid,
          graceMs: killGraceMs,
        });
        void escalation.done.then(() => {
          trySettle();
        });
      };

      const beginCancellation = (asTimeout: boolean): void => {
        if (settled) return;
        cancelRequested = true;
        if (asTimeout) timedOut = true;
        else aborted = true;
        if (closeResult) {
          closeResult = {
            ...closeResult,
            timedOut: closeResult.timedOut || timedOut,
          };
        }
        clearTimeoutTimer();
        signalProcessGroup(groupPid, "SIGTERM");
        armEscalation();
        trySettle();
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeoutTimer();
        detachAbort();
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

      // Attach lifecycle handlers BEFORE any abort/timeout cancellation can
      // kill the child, so a pre-aborted signal cannot race past close/error.
      spawned.once("error", (error) => {
        fail(error);
      });
      spawned.once("close", (code, signal) => {
        closeResult = {
          exitCode: code ?? 1,
          signal,
          timedOut,
        };
        if (!needsEscalationComplete()) {
          clearTimeoutTimer();
          detachAbort();
          trySettle();
          return;
        }
        // Leader closed after timeout/abort: do NOT cancel escalation.
        trySettle();
      });

      timer = setTimeout(() => {
        beginCancellation(true);
      }, input.timeoutMs);

      const onAbort = (): void => {
        beginCancellation(false);
      };
      if (input.signal) {
        // Subscribe first, then re-check aborted so an abort between the
        // initial observation and subscription cannot be missed.
        input.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => {
          input.signal?.removeEventListener("abort", onAbort);
        };
        if (input.signal.aborted) {
          onAbort();
        }
      }
    });
  } finally {
    clearTimeoutTimer();
    detachAbort();
    // Await armed escalation so fail/timer/abort all unblock this path.
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
