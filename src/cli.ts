import { existsSync, readFileSync } from "node:fs";
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
import { buildCodexInvocation, runCodex } from "./codex.js";
import { loadConfig } from "./config.js";
import { acquireRunLock } from "./lock.js";
import { renderPrompt } from "./prompt.js";
import {
  assertReportMatchesRequest,
  assertReportPreflight,
  loadRequest,
  parseReport,
} from "./validation.js";
import type { CodexResult } from "./codex.js";

interface InvokeInput {
  reportPath: string;
  requestSha256: string;
  prompt: string;
}

type InvokeCodex = (
  input: InvokeInput,
  signal?: AbortSignal,
) => Promise<CodexResult>;

interface CliDependencies {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  invokeCodex?: InvokeCodex;
  signal?: AbortSignal;
  secureReport?: (path: string) => void;
}

export interface SignalHandlerOptions {
  processObject?: NodeJS.Process;
  signals?: NodeJS.Signals[];
  controller?: AbortController;
}

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

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "build") {
    console.error("Usage: npm run cart -- build <grocery-list.json>");
    return 2;
  }

  const rootDir = resolve(dependencies.rootDir ?? process.cwd());
  const requestSource = resolve(argv[1]!);
  const secure =
    dependencies.secureReport ?? ((path: string) => secureReport(path));
  try {
    const request = loadRequest(requestSource);
    const requestSha256 = sha256(canonicalRequest(request));
    const config = loadConfig(dependencies.env ?? process.env, rootDir);
    if (!existsSync(config.playwrightMcpBin)) {
      throw new Error("Playwright MCP is not installed; run npm install");
    }

    const release = acquireRunLock(join(rootDir, ".wfm-cart.lock"));
    try {
      const paths = createRunPaths(rootDir);
      writeRequestSnapshot(requestSource, paths.requestPath);
      writeRunMetadata(paths, requestSource, requestSha256);
      const previousReport = findPreviousReport(
        config.runsDir,
        requestSha256,
      );
      const prompt = renderPrompt({
        request,
        requestSha256,
        expectedPostalCode: config.expectedPostalCode,
        previousReport,
        browserOutputDir: paths.browserOutputDir,
      });
      const signal = dependencies.signal;
      if (signal?.aborted) {
        console.error("Cart run aborted before Codex started");
        return 1;
      }
      const invoke: InvokeCodex =
        dependencies.invokeCodex ??
        (async (_input, runSignal) => {
          const invocation = buildCodexInvocation({
            rootDir,
            browserOutputDir: paths.browserOutputDir,
            reportPath: paths.reportPath,
            schemaPath: join(rootDir, "schemas", "report.schema.json"),
            playwrightMcpBin: config.playwrightMcpBin,
            playwrightMcpShim: config.playwrightMcpShim,
          });
          return runCodex({
            executable: config.codexBin,
            args: invocation.args,
            prompt,
            eventsPath: paths.eventsPath,
            stderrPath: paths.stderrPath,
            timeoutMs: config.maxRunMs,
            ...(runSignal ? { signal: runSignal } : {}),
          });
        });
      // Nested finally: if invocation was attempted (including reject after a
      // written report), always tighten report permissions. Outer finally still
      // releases the lock even when chmod throws.
      let invocationAttempted = false;
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
          console.error(`Cart run aborted; inspect ${paths.runDir}`);
          return 1;
        }
        if (result.timedOut || result.exitCode !== 0) {
          console.error(`Codex failed; inspect ${paths.runDir}`);
          return 1;
        }
        const report = parseReport(readFileSync(paths.reportPath, "utf8"));
        assertReportMatchesRequest(report, request);
        if (report.requestSha256 !== requestSha256) {
          throw new Error("Report requestSha256 does not match the request");
        }
        assertReportPreflight(report);
        if (report.checkoutVisited || report.settingsChanged) {
          console.error(`Safety condition violated; inspect ${paths.runDir}`);
          return 1;
        }
        console.log(`Cart run ${report.runStatus}: ${paths.reportPath}`);
        return report.runStatus === "failed" ? 1 : 0;
      } finally {
        if (invocationAttempted) {
          secure(paths.reportPath);
        }
      }
    } finally {
      release();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
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
