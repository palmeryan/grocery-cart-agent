import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  reserveLocalPort,
  type LaunchChromeInput,
} from "./browser.js";
import {
  connectToOwnedChrome,
  isWholeFoodsPage,
  runDeterministicCheck,
  type DeliveryContextExpectation,
} from "./deterministic-checks.js";
import {
  buildCodexInvocation,
  CART_AGENT_MODEL,
  CART_AGENT_REASONING_EFFORT,
  runCodex,
} from "./codex.js";
import { loadConfig } from "./config.js";
import {
  createPlaywrightCartPageAdapter,
  inspectCartState,
  type CartInspectionResult,
} from "./cart-state.js";
import {
  flattenCartAgentTasks,
  runCartAgentTasks,
  type CartAgentTask,
} from "./cart-agent.js";
import { acquireRunLock, type RunLock } from "./lock.js";
import { renderCartAgentPrompt, renderPrompt } from "./prompt.js";
import {
  buildCartReport,
  buildFailedCartReport,
  completeCartAgentResults,
} from "./report-builder.js";
import {
  assertAttachmentReportSafe,
  assertAuthReportSafe,
  assertReportMatchesRequest,
  assertReportPreflight,
  loadRequest,
  parseCartAgentResult,
  parseAttachmentReport,
  parseAuthReport,
  parseReport,
} from "./validation.js";
import type { CodexResult } from "./codex.js";
import type {
  AttachmentReport,
  AuthReport,
  CartAgentResult,
  OwnedChromeSession,
  RunPaths,
} from "./types.js";

interface InvokeInput {
  reportPath: string;
  requestSha256: string;
  prompt: string;
}

type InvokeCodex = (
  input: InvokeInput,
  signal?: AbortSignal,
) => Promise<CodexResult>;

interface InvokeCartAgentInput {
  task: CartAgentTask;
  priorResults: readonly CartAgentResult[];
  attemptDir: string;
  resultPath: string;
  prompt: string;
}

type InvokeCartAgent = (
  input: InvokeCartAgentInput,
  signal?: AbortSignal,
) => Promise<CartAgentResult>;

type CommandKind = RunPaths["kind"];

interface CliDependencies {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  invokeCodex?: InvokeCodex;
  invokeCartAgent?: InvokeCartAgent;
  /** @deprecated Use invokeCartAgent. */
  invokeIngredient?: InvokeCartAgent;
  inspectCart?: (
    session: OwnedChromeSession,
  ) => Promise<CartInspectionResult>;
  prepareCartAgentPage?: (session: OwnedChromeSession) => Promise<void>;
  signal?: AbortSignal;
  secureReport?: (path: string) => void;
  launchBrowser?: (input: LaunchChromeInput) => Promise<OwnedChromeSession>;
  reservePort?: () => Promise<number>;
  runDeterministicCheck?: (
    kind: "auth-check" | "attachment-check",
    session: OwnedChromeSession,
    expectation?: DeliveryContextExpectation,
  ) => Promise<AuthReport | AttachmentReport>;
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

const WHOLE_FOODS_URL = "https://www.wholefoodsmarket.com/grocery/search";
const WHOLE_FOODS_CART_URL = "https://www.wholefoodsmarket.com/grocery/cart";
const EXAMPLE_URL = "https://example.com";
const CART_AGENT_SCHEMA_PATH = "schemas/cart-agent-result.schema.json";

const inspectOwnedCart = async (
  session: OwnedChromeSession,
): Promise<CartInspectionResult> => {
  if (session.remoteDebuggingPort === undefined) {
    throw new Error("Chrome was not launched with a debugging port");
  }
  const browser = await connectToOwnedChrome(session.remoteDebuggingPort);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome exposed no browser context");
    const page = context.pages().find((candidate) =>
      isWholeFoodsPage(candidate.url()),
    );
    if (!page) throw new Error("Chrome exposed no Whole Foods browser page");
    return await inspectCartState(createPlaywrightCartPageAdapter(page), {
      cartUrl: WHOLE_FOODS_CART_URL,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const prepareOwnedCartAgentPage = async (
  session: OwnedChromeSession,
): Promise<void> => {
  if (session.remoteDebuggingPort === undefined) {
    throw new Error("Chrome was not launched with a debugging port");
  }
  const browser = await connectToOwnedChrome(session.remoteDebuggingPort);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome exposed no browser context");
    const page = context.pages().find((candidate) =>
      isWholeFoodsPage(candidate.url()),
    );
    if (!page) throw new Error("Chrome exposed no Whole Foods browser page");
    await page.goto(WHOLE_FOODS_URL, { waitUntil: "domcontentloaded" });
    if (!isWholeFoodsPage(page.url()) || /(?:^|\/)cart(?:\/|$)/i.test(new URL(page.url()).pathname)) {
      throw new Error(
        `Could not return the controlled tab to the Whole Foods shopping page: ${page.url()}`,
      );
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
};

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
    if (parsed.command === "build") {
      assertExecutable(config.playwrightMcpBin, "Playwright MCP");
    }

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
      writeRunMetadata(paths, requestSource!, requestSha256, {
        model: CART_AGENT_MODEL,
        reasoningEffort: CART_AGENT_REASONING_EFFORT,
      });
    }

    try {
      const remoteDebuggingPort =
        await (dependencies.reservePort ?? reserveLocalPort)();
      browser = await launchBrowser({
        executable: config.chromeExecutable,
        profileDir: config.profileDir,
        startupTimeoutMs: config.chromeStartupTimeoutMs,
        stopTimeoutMs: config.chromeStopTimeoutMs,
        launchUrl:
          parsed.command === "attachment-check"
            ? EXAMPLE_URL
            : WHOLE_FOODS_URL,
        ...(remoteDebuggingPort === undefined ? {} : { remoteDebuggingPort }),
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

    const signal = dependencies.signal;
    if (signal?.aborted) {
      if (parsed.command === "build") {
        const abortedPreflight: AuthReport = {
          runStatus: "failed",
          authenticated: false,
          deliveryModeConfirmed: false,
          deliveryAddressConfirmed: false,
          wholeFoodsStorefrontConfirmed: false,
          checkoutVisited: false,
          settingsChanged: false,
          failureReason: "Cart run aborted before deterministic preflight",
        };
        invocationAttempted = true;
        const report = buildFailedCartReport({
          request: request!,
          requestSha256,
          preflight: abortedPreflight,
          failureReason: abortedPreflight.failureReason!,
        });
        writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
          mode: 0o600,
        });
      }
      console.error(
        parsed.command === "build"
          ? "Cart run aborted before Codex started"
          : `${parsed.command} aborted before Codex started`,
      );
      exitCode = 1;
      return await finish();
    }

    if (parsed.command !== "build") {
      try {
        const check = dependencies.runDeterministicCheck ?? runDeterministicCheck;
        const report = await check(parsed.command, browser, {
          expectedAddressText: config.expectedDeliveryAddressText,
          deliveryMode: config.deliveryMode,
        });
        writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
          mode: 0o600,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 2;
        return await finish();
      }

      try {
        if (parsed.command === "auth-check") {
          const report = parseAuthReport(readFileSync(paths.reportPath, "utf8"));
          assertAuthReportSafe(report);
          console.log(`Auth check ${report.runStatus}: ${paths.reportPath}`);
          exitCode = report.runStatus === "failed" ? 1 : 0;
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
        exitCode = 1;
      }
      return await finish();
    }

    // Preserve the injectable whole-run seam used by the existing CLI
    // lifecycle tests. The real CLI never supplies this dependency and uses
    // the per-ingredient path below.
    if (dependencies.invokeCodex) {
      const previousReport = findPreviousReport(config.runsDir, requestSha256);
      const prompt = renderPrompt({
        request: request!,
        requestSha256,
        deliveryMode: config.deliveryMode,
        previousReport,
        browserOutputDir: paths.browserOutputDir,
      });
      try {
        invocationAttempted = true;
        const result = await dependencies.invokeCodex(
          {
            reportPath: paths.reportPath,
            requestSha256,
            prompt,
          },
          signal,
        );
        if (signal?.aborted) {
          console.error(`Cart run aborted; inspect ${paths.runDir}`);
          exitCode = 1;
        } else if (result.timedOut || result.exitCode !== 0) {
          console.error(`Codex failed; inspect ${paths.runDir}`);
          exitCode = 1;
        } else {
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
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 2;
      }
      return await finish();
    }

    const requestValue = request!;
    const check = dependencies.runDeterministicCheck ?? runDeterministicCheck;
    const inspect = dependencies.inspectCart ?? inspectOwnedCart;
    const preflight = (await check("auth-check", browser, {
      expectedAddressText: config.expectedDeliveryAddressText,
      deliveryMode: config.deliveryMode,
    })) as AuthReport;
    const preflightReady =
      preflight.runStatus === "completed" &&
      preflight.authenticated &&
      preflight.deliveryModeConfirmed &&
      preflight.deliveryAddressConfirmed &&
      preflight.wholeFoodsStorefrontConfirmed &&
      !preflight.checkoutVisited &&
      !preflight.settingsChanged;

    invocationAttempted = true;
    if (!preflightReady) {
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason:
          preflight.failureReason ??
          "Deterministic preflight did not confirm the Whole Foods delivery context",
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      console.error(`Cart preflight failed; inspect ${paths.runDir}`);
      exitCode = 1;
      return await finish();
    }

    let baseline: CartInspectionResult;
    try {
      baseline = await inspect(browser);
    } catch (error) {
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason: `Could not inspect the baseline cart: ${error instanceof Error ? error.message : String(error)}`,
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      console.error(`Cart baseline inspection failed; inspect ${paths.runDir}`);
      exitCode = 1;
      return await finish();
    }

    if (baseline.extractionStatus === "degraded") {
      const reason = `Baseline cart extraction was degraded${baseline.extractionDiagnostic ? `: ${baseline.extractionDiagnostic}` : ""}`;
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason: reason,
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      console.error(`Cart baseline verification failed; inspect ${paths.runDir}`);
      exitCode = 1;
      return await finish();
    }

    const prepareCartAgentPage =
      dependencies.prepareCartAgentPage ??
      (dependencies.inspectCart ? async () => undefined : prepareOwnedCartAgentPage);
    try {
      await prepareCartAgentPage(browser);
    } catch (error) {
      const reason =
        `Could not prepare the Whole Foods shopping page for the Cart Agent: ${error instanceof Error ? error.message : String(error)}`;
      const report = buildFailedCartReport({
        request: requestValue,
        requestSha256,
        preflight,
        failureReason: reason,
        baselineItems: baseline.items,
      });
      writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
        mode: 0o600,
      });
      console.error(`Cart Agent page preparation failed; inspect ${paths.runDir}`);
      exitCode = 1;
      return await finish();
    }

    const tasks = flattenCartAgentTasks(requestValue);
    const invokeCartAgent: InvokeCartAgent =
      dependencies.invokeCartAgent ??
      dependencies.invokeIngredient ??
      (async (input, runSignal) => {
        const remoteDebuggingPort = browser?.remoteDebuggingPort;
        if (remoteDebuggingPort === undefined) {
          throw new Error(
            "Owned Chrome did not expose a remote debugging port for the Cart Agent",
          );
        }
        const browserOutputDir = join(input.attemptDir, "browser");
        mkdirSync(browserOutputDir, { recursive: true, mode: 0o700 });
        const invocation = buildCodexInvocation({
          rootDir,
          browserOutputDir,
          reportPath: input.resultPath,
          schemaPath: join(rootDir, CART_AGENT_SCHEMA_PATH),
          playwrightMcpBin: config.playwrightMcpBin,
          remoteDebuggingPort,
        });
        const result = await runCodex({
          executable: config.codexBin,
          args: invocation.args,
          prompt: input.prompt,
          eventsPath: join(input.attemptDir, "codex-events.jsonl"),
          stderrPath: join(input.attemptDir, "codex-stderr.log"),
          timeoutMs: config.maxRunMs,
          ...(runSignal ? { signal: runSignal } : {}),
        });
        if (result.timedOut || result.exitCode !== 0) {
          throw new Error(
            `Cart Agent failed for ${input.task.ingredient.id}`,
          );
        }
        const parsedResult = parseCartAgentResult(
          readFileSync(input.resultPath, "utf8"),
        );
        if (parsedResult.ingredientId !== input.task.ingredient.id) {
          throw new Error(
            `Cart Agent returned ${parsedResult.ingredientId} for ${input.task.ingredient.id}`,
          );
        }
        return parsedResult;
      });

    const progress = await runCartAgentTasks({
      tasks,
      session: browser,
      invokeAgent: async ({ task, priorResults, signal: agentSignal }) => {
        const attemptDir = join(
          paths!.runDir,
          "ingredients",
          task.ingredient.id,
        );
        mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
        const resultPath = join(attemptDir, "result.json");
        const prompt = renderCartAgentPrompt({
          task,
          deliveryMode: config.deliveryMode,
          cartContext: {
            baselineItems: baseline.items,
            priorResults,
          },
          browserOutputDir: join(attemptDir, "browser"),
        });
        return await invokeCartAgent(
          {
            task,
            priorResults,
            attemptDir,
            resultPath,
            prompt,
          },
          agentSignal,
        );
      },
      ...(signal ? { signal } : {}),
      onProgress: async (current) => {
        writeFileSync(
          join(paths!.runDir, "progress.json"),
          `${JSON.stringify(current)}\n`,
          { mode: 0o600 },
        );
      },
    });

    let final: CartInspectionResult;
    let finalInspectionFailure: string | null = null;
    try {
      final = await inspect(browser);
    } catch (error) {
      final = {
        ...baseline,
        bodyText: "",
      };
      finalInspectionFailure =
        `Could not inspect the final cart: ${error instanceof Error ? error.message : String(error)}`;
    }

    const resultReason =
      progress.stopReason ?? "The outer ingredient loop did not complete";
    const results = completeCartAgentResults(
      requestValue,
      progress.results.map(({ result }) => result),
      resultReason,
    );
    const report = buildCartReport({
      request: requestValue,
      requestSha256,
      preflight,
      baseline,
      final,
      results,
      stopped: progress.stopped,
      stopReason: progress.stopReason,
      ...(finalInspectionFailure
        ? { additionalVerificationNotes: [finalInspectionFailure] }
        : {}),
    });
    writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, {
      mode: 0o600,
    });

    try {
      assertReportMatchesRequest(report, requestValue);
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
