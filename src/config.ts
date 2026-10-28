import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  rootDir: string;
  runsDir: string;
  profileDir: string;
  maxRunMs: number;
  codexBin: string;
  chromeExecutable: string;
  chromeStartupTimeoutMs: number;
  chromeStopTimeoutMs: number;
}

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
  name: string,
): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): AppConfig {
  const home = env.HOME ?? homedir();
  const profileDir = env.WFM_CHROME_PROFILE_DIR
    ? resolve(env.WFM_CHROME_PROFILE_DIR)
    : join(home, ".whole-foods-cart", "chrome-profile");
  if (!isAbsolute(profileDir)) {
    throw new Error("WFM_CHROME_PROFILE_DIR must resolve to an absolute path");
  }

  const maxRunMs = Number(env.WFM_MAX_RUN_MS ?? "1800000");
  if (!Number.isInteger(maxRunMs) || maxRunMs < 60_000) {
    throw new Error("WFM_MAX_RUN_MS must be an integer of at least 60000");
  }

  const absoluteRoot = resolve(rootDir);
  return {
    rootDir: absoluteRoot,
    runsDir: join(absoluteRoot, "runs"),
    profileDir,
    maxRunMs,
    codexBin: env.CODEX_BIN ?? "codex",
    chromeExecutable:
      env.CHROME_EXECUTABLE ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chromeStartupTimeoutMs: parsePositiveInt(
      env.WFM_CHROME_STARTUP_TIMEOUT_MS,
      15_000,
      "WFM_CHROME_STARTUP_TIMEOUT_MS",
    ),
    chromeStopTimeoutMs: parsePositiveInt(
      env.WFM_CHROME_STOP_TIMEOUT_MS,
      10_000,
      "WFM_CHROME_STOP_TIMEOUT_MS",
    ),
  };
}
