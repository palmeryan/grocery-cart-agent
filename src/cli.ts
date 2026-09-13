import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalRequest,
  createRunPaths,
  findPreviousReport,
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
  loadRequest,
  parseReport,
} from "./validation.js";
import type { CodexResult } from "./codex.js";

interface InvokeInput {
  reportPath: string;
  requestSha256: string;
  prompt: string;
}

interface CliDependencies {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  invokeCodex?: (input: InvokeInput) => Promise<CodexResult>;
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
      });
      const invoke = dependencies.invokeCodex ?? (async () => {
        const invocation = buildCodexInvocation({
          rootDir,
          profileDir: config.profileDir,
          browserOutputDir: paths.browserOutputDir,
          reportPath: paths.reportPath,
          schemaPath: join(rootDir, "schemas", "report.schema.json"),
          playwrightMcpBin: config.playwrightMcpBin,
        });
        return runCodex({
          executable: config.codexBin,
          args: invocation.args,
          prompt,
          eventsPath: paths.eventsPath,
          stderrPath: paths.stderrPath,
          timeoutMs: config.maxRunMs,
        });
      });
      const result = await invoke({
        reportPath: paths.reportPath,
        requestSha256,
        prompt,
      });
      if (result.timedOut || result.exitCode !== 0) {
        console.error(`Codex failed; inspect ${paths.runDir}`);
        return 1;
      }
      const report = parseReport(readFileSync(paths.reportPath, "utf8"));
      assertReportMatchesRequest(report, request);
      if (report.requestSha256 !== requestSha256) {
        throw new Error("Report requestSha256 does not match the request");
      }
      if (report.checkoutVisited || report.settingsChanged) {
        console.error(`Safety condition violated; inspect ${paths.runDir}`);
        return 1;
      }
      console.log(`Cart run ${report.runStatus}: ${paths.reportPath}`);
      return report.runStatus === "failed" ? 1 : 0;
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
  process.exitCode = await runCli(process.argv.slice(2));
}
