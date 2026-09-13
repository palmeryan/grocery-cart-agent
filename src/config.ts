import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  rootDir: string;
  runsDir: string;
  profileDir: string;
  expectedPostalCode: string;
  maxRunMs: number;
  codexBin: string;
  playwrightMcpBin: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = process.cwd(),
): AppConfig {
  const expectedPostalCode = env.WFM_EXPECTED_POSTAL_CODE?.trim();
  if (!expectedPostalCode || !/^[0-9]{5}$/.test(expectedPostalCode)) {
    throw new Error("WFM_EXPECTED_POSTAL_CODE must be a five-digit US postal code");
  }

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
    expectedPostalCode,
    maxRunMs,
    codexBin: env.CODEX_BIN ?? "codex",
    playwrightMcpBin: env.PLAYWRIGHT_MCP_BIN ?? join(
      absoluteRoot,
      "node_modules",
      ".bin",
      "playwright-mcp",
    ),
  };
}
