import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { RunPaths } from "./types.js";

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
};

export const canonicalShoppingList = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;

export function createRunPaths(
  rootDir: string,
  now = new Date(),
  kind: RunPaths["kind"] = "build",
): RunPaths {
  const runId = now.toISOString().replaceAll(":", "-").replace(".", "-");
  const runDir = join(rootDir, "runs", runId);
  const browserOutputDir = join(runDir, "browser");
  mkdirSync(browserOutputDir, { recursive: true, mode: 0o700 });
  return {
    kind,
    runId,
    runDir,
    shoppingListPath: join(runDir, "shopping-list.json"),
    reportPath: join(runDir, "report.json"),
    eventsPath: join(runDir, "codex-events.jsonl"),
    stderrPath: join(runDir, "codex-stderr.log"),
    browserOutputDir,
  };
}

export function writeShoppingListSnapshot(source: string, destination: string): void {
  cpSync(source, destination, { errorOnExist: true });
  chmodSync(destination, 0o600);
}

/**
 * Best-effort: if Codex wrote report.json, force owner-only mode.
 * No-op when the file is absent.
 */
export function secureReport(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, 0o600);
}

export function writeRunMetadata(
  paths: RunPaths,
  requestSource: string,
  requestSha256: string,
  modelSettings: Record<string, string>,
): void {
  writeFileSync(
    join(paths.runDir, "metadata.json"),
    `${JSON.stringify({
      requestSource: basename(requestSource),
      requestSha256,
      ...modelSettings,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
