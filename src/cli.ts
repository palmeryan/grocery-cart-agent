import { accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalRequest,
  createRunPaths,
  findPreviousReport,
  secureReport,
  sha256,
  writeRequestSnapshot,
  writeRunMetadata,
} from "./artifacts.js";
import {
  BrowserLaunchError,
  launchOwnedChrome,
  type LaunchChromeInput,
} from "./browser.js";
import { buildCodexInvocation, runCodex } from "./codex.js";
import { loadConfig } from "./config.js";
import {
  assertExtensionTokenAvailable,
  type KeychainCheckInput,
} from "./keychain.js";
import { acquireRunLock, type RunLock } from "./lock.js";
import {
  renderAttachmentPrompt,
  renderAuthPrompt,
  renderPrompt,
} from "./prompt.js";
import {
  assertAttachmentReportSafe,
  assertAuthReportSafe,
  assertReportMatchesRequest,
  assertReportPreflight,
  loadRequest,
  parseAttachmentReport,
  parseAuthReport,
  parseReport,
} from "./validation.js";
import type { CodexResult } from "./codex.js";
import type { OwnedChromeSession, RunPaths } from "./types.js";

interface InvokeInput {
  reportPath: string;
  requestSha256: string;
  prompt: string;
}

type InvokeCodex = (
  input: InvokeInput,
  signal?: AbortSignal,
) => Promise<CodexResult>;

type CommandKind = RunPaths["kind"];

interface CliDependencies {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  invokeCodex?: InvokeCodex;
  signal?: AbortSignal;
  secureReport?: (path: string) => void;
  checkExtensionToken?: (input: KeychainCheckInput) => void;
  launchBrowser?: (input: LaunchChromeInput) => Promise<OwnedChromeSession>;
  releaseLock?: (lock: RunLock) => void;
}

export interface SignalHandlerOptions {
  processObject?: NodeJS.Process;
  signals?: NodeJS.Signals[];
  controller?: AbortController;
}

const USAGE = `usage: cart build <request.json>
       cart auth-check
       cart attachment-check`;

const WHOLE_FOODS_URL = "https://www.amazon.com/wholefoods";
const EXAMPLE_URL = "https://example.com";

/**
 * Install SIGINT/SIGTERM handlers only for the real CLI entrypoint lifetime.
 * Handlers abort the controller and are always removed in `finally`.
 */
export async function withCliSignalHandlers<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: SignalHandlerOptions = {},
): Promise<T> {
  const processObject = options.processObject ?? process;
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  const controller = options.controller ?? new AbortController();

  const onSignal = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of signals) {
    processObject.on(signal, onSignal);
  }
  try {
    return await run(controller.signal);
  } finally {
    for (const signal of signals) {
      processObject.off(signal, onSignal);
    }
  }
}

const parseCommand = (
  argv: string[],
): { command: CommandKind; requestPath?: string } | null => {
  if (argv[0] === "build" && argv.length === 2 && argv[1]) {
    return { command: "build", requestPath: argv[1] };
  }
  if (argv[0] === "auth-check" && argv.length === 1) {
    return { command: "auth-check" };
  }
  if (argv[0] === "attachment-check" && argv.length === 1) {
    return { command: "attachment-check" };
  }
  return null;
};

const assertExecutable = (path: string, label: string): void => {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is missing or not executable: ${path}`);
  }
};

const schemaPathFor = (rootDir: string, command: CommandKind): string => {
  if (command === "build") return join(rootDir, "schemas", "report.schema.json");
  if (command === "auth-check") {
    return join(rootDir, "schemas", "auth-report.schema.json");
  }
  return join(rootDir, "schemas", "attachment-report.schema.json");
};

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }

  const rootDir = resolve(dependencies.rootDir ?? process.cwd());
  const secure =
    dependencies.secureReport ?? ((path: string) => secureReport(path));
  const checkExtensionToken =
    dependencies.checkExtensionToken ?? assertExtensionTokenAvailable;
  const launchBrowser = dependencies.launchBrowser ?? launchOwnedChrome;
  const releaseLock =
    dependencies.releaseLock ?? ((lock: RunLock) => lock.release());

  let lock: RunLock | undefined;
  let browser: OwnedChromeSession | undefined;
  let paths: RunPaths | undefined;
  let exitCode = 2;
  let lockAcquired = false;
  let retainLock = false;
  let cleanupFailed = false;
  let invocationAttempted = false;
  let cleanupPromise: Promise<number> | undefined;
  const lockPath = join(rootDir, ".wfm-cart.lock");

  /** Single-entry cleanup: concurrent/repeated calls share one promise. */
  const finish = (): Promise<number> => {
    if (!cleanupPromise) {
      cleanupPromise = runCleanup();
    }
    return cleanupPromise;
  };

  async function runCleanup(): Promise<number> {
    // Codex/invoke must have settled (or never started) before browser stop.
    if (lockAcquired && lock) {
      const heldLock = lock;
      try {
        if (invocationAttempted && paths) {
          try {
            secure(paths.reportPath);
          } catch (error) {
            cleanupFailed = true;
            console.error(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (browser) {
          try {
            const stopped = await browser.stop();
            if (!stopped.stopped) {
              retainLock = true;
              cleanupFailed = true;
              console.error(
                `Chrome still uses the dedicated profile (PIDs: ${stopped.remainingProfilePids.join(", ")}). Confirm those processes are gone, then manually remove ${lockPath}.`,
              );
            }
          } catch (error) {
            // Thrown stop => uncertain browser state: never release the lock.
            retainLock = true;
            cleanupFailed = true;
            console.error(
              error instanceof Error
                ? `Chrome stop failed: ${error.message}. Confirm dedicated-profile Chrome is gone, then manually remove ${lockPath}.`
                : `Chrome stop failed. Confirm dedicated-profile Chrome is gone, then manually remove ${lockPath}.`,
            );
          }
        }
      } finally {
        if (!retainLock) {
          releaseLock(heldLock);
        } else {
          heldLock.retain();
        }
      }
      if (cleanupFailed) exitCode = 2;
    }
    return exitCode;
  }

  try {
    const config = loadConfig(dependencies.env ?? process.env, rootDir);
    assertExecutable(config.chromeExecutable, "Chrome executable");
    assertExecutable(config.playwrightMcpBin, "Playwright MCP");
    assertExecutable(config.playwrightMcpShim, "Playwright MCP shim");

    checkExtensionToken({
      account: config.keychainAccount,
      service: config.keychainService,
    });

    const requestSource =
      parsed.command === "build" ? resolve(parsed.requestPath!) : undefined;
    const request =
      parsed.command === "build" ? loadRequest(requestSource!) : undefined;
    const requestSha256 =
      parsed.command === "build"
        ? sha256(canonicalRequest(request!))
        : sha256(parsed.command);

    lock = acquireRunLock(lockPath);
    lockAcquired = true;

    paths = createRunPaths(rootDir, new Date(), parsed.command);
    if (parsed.command === "build") {
      writeRequestSnapshot(requestSource!, paths.requestPath);
      writeRunMetadata(paths, requestSource!, requestSha256);
    }

    try {
      browser = await launchBrowser({
        executable: config.chromeExecutable,
        profileDir: config.profileDir,
        startupTimeoutMs: config.chromeStartupTimeoutMs,
        stopTimeoutMs: config.chromeStopTimeoutMs,
        launchUrl:
          parsed.command === "attachment-check"
            ? EXAMPLE_URL
            : WHOLE_FOODS_URL,
      });
    } catch (error) {
      if (error instanceof BrowserLaunchError) {
        retainLock = error.requiresLockRetention;
      } else {
        // Unknown launch failures retain conservatively.
        retainLock = true;
      }
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = 2;
      // Fall through to cleanup; do not run Codex.
      return await finish();
    }

    let prompt: string;
    if (parsed.command === "build") {
      const previousReport = findPreviousReport(config.runsDir, requestSha256);
      prompt = renderPrompt({
        request: request!,
        requestSha256,
        expectedPostalCode: config.expectedPostalCode,
        previousReport,
        browserOutputDir: paths.browserOutputDir,
      });
    } else if (parsed.command === "auth-check") {
      prompt = renderAuthPrompt({
        expectedPostalCode: config.expectedPostalCode,
        browserOutputDir: paths.browserOutputDir,
      });
    } else {
      prompt = renderAttachmentPrompt();
    }

    const signal = dependencies.signal;
    if (signal?.aborted) {
      console.error(
        parsed.command === "build"
          ? "Cart run aborted before Codex started"
          : `${parsed.command} aborted before Codex started`,
      );
      exitCode = 1;
      return await finish();
    }

    const invoke: InvokeCodex =
      dependencies.invokeCodex ??
      (async (_input, runSignal) => {
        const invocation = buildCodexInvocation({
          rootDir,
          browserOutputDir: paths!.browserOutputDir,
          reportPath: paths!.reportPath,
          schemaPath: schemaPathFor(rootDir, parsed.command),
          playwrightMcpBin: config.playwrightMcpBin,
          playwrightMcpShim: config.playwrightMcpShim,
        });
        return runCodex({
          executable: config.codexBin,
          args: invocation.args,
          prompt,
          eventsPath: paths!.eventsPath,
          stderrPath: paths!.stderrPath,
          timeoutMs: config.maxRunMs,
          ...(runSignal ? { signal: runSignal } : {}),
        });
      });

    try {
      invocationAttempted = true;
      const result = await invoke(
        {
          reportPath: paths.reportPath,
          requestSha256,
          prompt,
        },
        signal,
      );

      if (signal?.aborted) {
        console.error(
          parsed.command === "build"
            ? `Cart run aborted; inspect ${paths.runDir}`
            : `${parsed.command} aborted; inspect ${paths.runDir}`,
        );
        exitCode = 1;
      } else if (result.timedOut || result.exitCode !== 0) {
        console.error(`Codex failed; inspect ${paths.runDir}`);
        exitCode = 1;
      } else if (parsed.command === "build") {
        const report = parseReport(readFileSync(paths.reportPath, "utf8"));
        assertReportMatchesRequest(report, request!);
        if (report.requestSha256 !== requestSha256) {
          throw new Error("Report requestSha256 does not match the request");
        }
        assertReportPreflight(report);
        if (report.checkoutVisited || report.settingsChanged) {
          console.error(`Safety condition violated; inspect ${paths.runDir}`);
          exitCode = 1;
        } else {
          console.log(`Cart run ${report.runStatus}: ${paths.reportPath}`);
          exitCode = report.runStatus === "failed" ? 1 : 0;
        }
      } else if (parsed.command === "auth-check") {
        const report = parseAuthReport(readFileSync(paths.reportPath, "utf8"));
        try {
          assertAuthReportSafe(report);
          console.log(`Auth check ${report.runStatus}: ${paths.reportPath}`);
          exitCode = report.runStatus === "failed" ? 1 : 0;
        } catch (error) {
          // Auth gate/safety failures are soft failures (exit 1), not
          // orchestration/schema failures (exit 2).
          console.error(
            error instanceof Error ? error.message : "Auth check failed",
          );
          exitCode = 1;
        }
      } else {
        const report = parseAttachmentReport(
          readFileSync(paths.reportPath, "utf8"),
        );
        assertAttachmentReportSafe(report);
        console.log(`Attachment check connected: ${paths.reportPath}`);
        exitCode = 0;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = 2;
    }

    return await finish();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 2;
    return await finish();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  // Signal handlers are installed only for the real CLI process lifetime.
  process.exitCode = await withCliSignalHandlers((signal) =>
    runCli(process.argv.slice(2), { signal }),
  );
}
