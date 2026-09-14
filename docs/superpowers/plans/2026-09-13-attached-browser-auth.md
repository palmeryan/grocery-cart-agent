# Attached-Browser Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch the dedicated Whole Foods Chrome profile on demand, attach Playwright MCP through the official extension with a Keychain-backed token, and close the owned browser safely after cart and authentication-check runs.

**Architecture:** The TypeScript CLI validates local prerequisites, acquires the existing exclusive lock, launches one owned Chrome process group, and invokes Codex only after Chrome is ready. Codex starts a trusted shell shim over stdio; the shim reads the extension token from macOS Keychain and execs the pinned Playwright MCP in extension mode. A separate auth-only prompt and schema reuse the lifecycle without reading or modifying the cart.

**Tech Stack:** Node.js 22, TypeScript 5.9, Vitest 5, AJV 8, macOS `security`, Google Chrome, `@playwright/mcp` 0.0.80, Playwright MCP Browser Extension

## Global Constraints

- Use the dedicated profile at `~/.whole-foods-cart/chrome-profile`; never attach to the everyday Chrome profile.
- Use Keychain service `whole-foods-cart.playwright-extension` and account equal to the current macOS username.
- Keep the extension token out of Git, command-line arguments, Codex prompts, Codex's environment, run artifacts, and logs.
- Keep Codex `--ignore-user-config`, strict/ephemeral configuration, `approval_policy="never"`, read-only sandbox, and `default_tools_approval_mode="approve"`.
- Keep pinned `@playwright/mcp` `0.0.80` unless the harmless extension compatibility gate proves an upgrade is required.
- Do not add CDP, exported storage state, network MCP transport, or cookie copying.
- Stop Codex and its MCP descendants before Chrome; release `.wfm-cart.lock` only after the dedicated profile is confirmed idle.
- If owned Chrome cannot be confirmed stopped, retain the lock and print token-free manual recovery instructions.
- All automated tests are offline and must not launch real Chrome, access Keychain, contact Amazon, or invoke the real extension.
- Do not run a live cart smoke test without renewed explicit approval at that gate.

---

## File Structure

**Create**

- `src/keychain.ts`: Keychain item existence check and fixed identity.
- `src/browser.ts`: profile process discovery and owned Chrome lifecycle.
- `prompts/auth-check.md`: fixed non-mutating browser instructions.
- `prompts/attachment-check.md`: fixed Example Domain attachment instructions.
- `schemas/auth-report.schema.json`: strict auth-only output contract.
- `schemas/attachment-report.schema.json`: strict harmless attachment contract.
- `scripts/setup-extension-token.sh`: interactive Keychain setup without token arguments.
- `scripts/playwright-extension-mcp.sh`: trusted token-reading stdio MCP shim.
- `tests/keychain.test.ts`: Keychain command and redaction tests.
- `tests/browser.test.ts`: owned-process lifecycle and lock-safety tests.
- `tests/fixtures/valid-auth-report.json`: valid auth-only report.
- `tests/fixtures/valid-attachment-report.json`: valid harmless attachment report.

**Modify**

- `src/config.ts`: add Chrome, timeout, Keychain, and shim configuration.
- `src/types.ts`: add auth report and browser session types.
- `src/validation.ts`: compile and validate the auth-only report.
- `src/prompt.ts`: render the auth-only prompt.
- `src/codex.ts`: configure the shim and remove browser-launch arguments.
- `src/cli.ts`: add `auth-check` and enforce lifecycle cleanup ordering.
- `src/artifacts.ts`: create auth-check run paths without a grocery snapshot.
- `tests/artifacts.test.ts`: validate new configuration defaults.
- `tests/codex.test.ts`: verify extension-mode invocation.
- `tests/prompt.test.ts`: prove the auth prompt contains no cart mutation.
- `tests/validation.test.ts`: verify auth report gates and schema.
- `tests/cli.test.ts`: cover browser cleanup, lock retention, and auth-check results.
- `package.json`: add token setup and auth-check convenience scripts.
- `README.md`: document setup, auth check, cleanup, and recovery.
- `docs/manual-test-runbook.md`: add staged extension acceptance gates.

---

### Task 1: Keychain Configuration and Trusted MCP Shim

**Files:**
- Create: `src/keychain.ts`
- Create: `scripts/setup-extension-token.sh`
- Create: `scripts/playwright-extension-mcp.sh`
- Create: `tests/keychain.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/artifacts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv`, repository root path, and macOS `security`.
- Produces:
  - `KEYCHAIN_SERVICE = "whole-foods-cart.playwright-extension"`
  - `keychainLookupArgs(account: string, service?: string): string[]`
  - `assertExtensionTokenAvailable(input: KeychainCheckInput): void`
  - `AppConfig.chromeExecutable: string`
  - `AppConfig.chromeStartupTimeoutMs: number`
  - `AppConfig.chromeStopTimeoutMs: number`
  - `AppConfig.keychainService: string`
  - `AppConfig.keychainAccount: string`
  - `AppConfig.playwrightMcpShim: string`
- The shim contract is exactly two positional arguments: absolute pinned MCP binary, then absolute browser output directory.

- [ ] **Step 1: Write failing configuration and Keychain tests**

Create `tests/keychain.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_SERVICE,
  assertExtensionTokenAvailable,
  keychainLookupArgs,
} from "../src/keychain.js";

describe("extension token Keychain access", () => {
  it("uses the fixed service and current account without a token argument", () => {
    expect(keychainLookupArgs("ryan")).toEqual([
      "find-generic-password",
      "-a",
      "ryan",
      "-s",
      KEYCHAIN_SERVICE,
    ]);
  });

  it("checks item metadata without printing or requesting the token", () => {
    const execFile = vi.fn(() => "");
    assertExtensionTokenAvailable({
      account: "ryan",
      service: KEYCHAIN_SERVICE,
      execFile,
    });
    expect(execFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-a", "ryan", "-s", KEYCHAIN_SERVICE],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  });

  it("returns a token-free recovery error", () => {
    expect(() =>
      assertExtensionTokenAvailable({
        account: "ryan",
        service: KEYCHAIN_SERVICE,
        execFile: () => {
          throw new Error("synthetic secret output");
        },
      }),
    ).toThrow(
      `Playwright extension token is unavailable in Keychain service ${KEYCHAIN_SERVICE} for account ryan`,
    );
  });
});

describe("extension MCP shim", () => {
  it("keeps the token out of output and child arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-shim-"));
    const bin = join(root, "fake-mcp");
    const outputDir = join(root, "browser");
    const security = join(root, "security");
    mkdirSync(outputDir);
    writeFileSync(
      security,
      "#!/bin/sh\nprintf '%s\\n' 'secret-token'\n",
      { mode: 0o700 },
    );
    writeFileSync(
      bin,
      "#!/bin/sh\nprintf 'ARGS=%s\\n' \"$*\"\nprintf 'TOKEN_SET=%s\\n' \"${PLAYWRIGHT_MCP_EXTENSION_TOKEN:+yes}\"\n",
      { mode: 0o700 },
    );
    const shim = join(process.cwd(), "scripts/playwright-extension-mcp.sh");
    chmodSync(shim, 0o700);
    const output = execFileSync(shim, [bin, outputDir], {
      env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, USER: "ryan" },
      encoding: "utf8",
    });
    expect(output).toContain("TOKEN_SET=yes");
    expect(output).toContain(`ARGS=--extension --output-dir=${outputDir} --caps=devtools`);
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("--user-data-dir");
    expect(output).not.toContain("--cdp-endpoint");
    expect(output).not.toContain("--storage-state");
  });
});
```

Append to the `configuration` describe block in `tests/artifacts.test.ts`:

```ts
it("configures owned Chrome and the fixed Keychain identity", () => {
  const config = loadConfig(
    {
      HOME: "/Users/test",
      USER: "test",
      WFM_EXPECTED_POSTAL_CODE: "00000",
    },
    "/repo",
  );
  expect(config.chromeExecutable).toBe(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  expect(config.chromeStartupTimeoutMs).toBe(15_000);
  expect(config.chromeStopTimeoutMs).toBe(10_000);
  expect(config.keychainService).toBe(
    "whole-foods-cart.playwright-extension",
  );
  expect(config.keychainAccount).toBe("test");
  expect(config.playwrightMcpShim).toBe(
    "/repo/scripts/playwright-extension-mcp.sh",
  );
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
npm test -- tests/keychain.test.ts tests/artifacts.test.ts
```

Expected: failure because `src/keychain.ts`, both shell scripts, and the new `AppConfig` fields do not exist.

- [ ] **Step 3: Implement fixed Keychain lookup and configuration**

Create `src/keychain.ts`:

```ts
import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "whole-foods-cart.playwright-extension";

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { stdio: ["ignore", "ignore", "ignore"] },
) => unknown;

export interface KeychainCheckInput {
  account: string;
  service?: string;
  execFile?: ExecFile;
}

export const keychainLookupArgs = (
  account: string,
  service = KEYCHAIN_SERVICE,
): string[] => [
  "find-generic-password",
  "-a",
  account,
  "-s",
  service,
];

export function assertExtensionTokenAvailable(
  input: KeychainCheckInput,
): void {
  const service = input.service ?? KEYCHAIN_SERVICE;
  try {
    (input.execFile ?? execFileSync)(
      "security",
      keychainLookupArgs(input.account, service),
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  } catch {
    throw new Error(
      `Playwright extension token is unavailable in Keychain service ${service} for account ${input.account}`,
    );
  }
}
```

Extend the existing `AppConfig` and `loadConfig` in `src/config.ts` with:

```ts
export interface AppConfig {
  rootDir: string;
  runsDir: string;
  profileDir: string;
  expectedPostalCode: string;
  maxRunMs: number;
  codexBin: string;
  playwrightMcpBin: string;
  chromeExecutable: string;
  chromeStartupTimeoutMs: number;
  chromeStopTimeoutMs: number;
  keychainService: string;
  keychainAccount: string;
  playwrightMcpShim: string;
}
```

Add this parser below the imports:

```ts
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
```

Keep the existing `WFM_MAX_RUN_MS` validation unchanged. Use these exact values
in the return object:

```ts
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
keychainService: "whole-foods-cart.playwright-extension",
keychainAccount: env.USER ?? userInfo().username,
playwrightMcpShim:
  env.PLAYWRIGHT_MCP_SHIM ??
  join(absoluteRoot, "scripts", "playwright-extension-mcp.sh"),
```

Import `userInfo` alongside `homedir` from `node:os`.

- [ ] **Step 4: Implement secure setup and MCP shim scripts**

Create `scripts/setup-extension-token.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

service="whole-foods-cart.playwright-extension"
account="${USER:?USER is required}"

security add-generic-password \
  -U \
  -a "$account" \
  -s "$service" \
  -w

security find-generic-password \
  -a "$account" \
  -s "$service" \
  >/dev/null

printf 'Stored Playwright extension token in macOS Keychain for service %s.\\n' "$service"
```

Create `scripts/playwright-extension-mcp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

if [[ "$#" -ne 2 ]]; then
  printf 'usage: playwright-extension-mcp.sh <absolute-mcp-bin> <absolute-output-dir>\\n' >&2
  exit 64
fi

mcp_bin="$1"
output_dir="$2"
service="whole-foods-cart.playwright-extension"
account="${USER:?USER is required}"

if [[ "$mcp_bin" != /* || ! -x "$mcp_bin" ]]; then
  printf 'Playwright MCP binary must be an executable absolute path.\\n' >&2
  exit 66
fi
if [[ "$output_dir" != /* || ! -d "$output_dir" ]]; then
  printf 'Browser output directory must be an existing absolute path.\\n' >&2
  exit 66
fi

token="$(security find-generic-password -a "$account" -s "$service" -w)"
if [[ -z "$token" ]]; then
  printf 'Playwright extension token is empty.\\n' >&2
  exit 78
fi

PLAYWRIGHT_MCP_EXTENSION_TOKEN="$token" exec "$mcp_bin" \
  --extension \
  "--output-dir=$output_dir" \
  --caps=devtools
```

Make both scripts executable and add package scripts:

```bash
chmod 0755 scripts/setup-extension-token.sh scripts/playwright-extension-mcp.sh
```

```json
"setup-extension-token": "bash scripts/setup-extension-token.sh",
"auth-check": "tsx src/cli.ts auth-check"
```

- [ ] **Step 5: Run focused validation**

Run:

```bash
npm test -- tests/keychain.test.ts tests/artifacts.test.ts
npm run typecheck
```

Expected: both commands pass. No test invokes the real `security` command because the shim test shadows it in `PATH`.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/keychain.ts scripts/setup-extension-token.sh scripts/playwright-extension-mcp.sh tests/keychain.test.ts tests/artifacts.test.ts package.json
git commit -m "feat: add extension token isolation"
```

---

### Task 2: Owned Chrome Session Manager

**Files:**
- Create: `src/browser.ts`
- Create: `tests/browser.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `chromeExecutable`, `profileDir`, startup/stop timeouts, and injected process functions in tests.
- Produces:
  - `listProfileProcessIds(profileDir: string, execFile?: ExecFileText): number[]`
  - `launchOwnedChrome(input: LaunchChromeInput): Promise<OwnedChromeSession>`
  - `BrowserLaunchError.requiresLockRetention: boolean`
  - `OwnedChromeSession.pid: number`
  - `OwnedChromeSession.stop(): Promise<BrowserStopResult>`
  - `BrowserStopResult = { stopped: boolean; remainingProfilePids: number[] }`
- The manager signals only the process group whose leader PID came from its own `spawn`.

- [ ] **Step 1: Write failing ownership and lifecycle tests**

Create `tests/browser.test.ts` with a fake process adapter:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  launchOwnedChrome,
  listProfileProcessIds,
} from "../src/browser.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

describe("profile process discovery", () => {
  it("returns only processes using the exact dedicated profile argument", () => {
    const stdout = [
      "101 /Applications/Google Chrome --user-data-dir=/profiles/wfm",
      "102 /Applications/Google Chrome --user-data-dir=/profiles/everyday",
      "103 /Applications/Google Chrome --type=renderer --user-data-dir=/profiles/wfm",
    ].join("\\n");
    expect(
      listProfileProcessIds("/profiles/wfm", () => stdout),
    ).toEqual([101, 103]);
  });
});

describe("owned Chrome lifecycle", () => {
  it("refuses a profile already used before launch", async () => {
    await expect(
      launchOwnedChrome({
        executable: "/Applications/Google Chrome",
        profileDir: "/profiles/wfm",
        startupTimeoutMs: 100,
        stopTimeoutMs: 100,
        listProfilePids: () => [999],
        spawnChrome: vi.fn(),
      }),
    ).rejects.toThrow("Dedicated Chrome profile is already active");
  });

  it("launches normal Chrome and stops its owned process group", async () => {
    const child = new FakeChild();
    const signals: Array<[number, NodeJS.Signals]> = [];
    let checks = 0;
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
      launchUrl: "https://www.amazon.com/wholefoods",
      spawnChrome: vi.fn(() => child),
      listProfilePids: () => (++checks === 1 ? [] : checks < 4 ? [4242] : []),
      signalGroup: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") child.emit("exit", 0, "SIGTERM");
      },
      sleep: async () => undefined,
    });
    expect(session.pid).toBe(4242);
    await expect(session.stop()).resolves.toEqual({
      stopped: true,
      remainingProfilePids: [],
    });
    expect(signals).toEqual([[4242, "SIGTERM"]]);
  });

  it("escalates owned Chrome after the graceful timeout", async () => {
    const child = new FakeChild();
    const signals: NodeJS.Signals[] = [];
    let stopping = false;
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      spawnChrome: () => child,
      listProfilePids: () => (stopping && signals.includes("SIGKILL") ? [] : [4242]),
      signalGroup: (_pid, signal) => {
        stopping = true;
        signals.push(signal);
      },
      sleep: async () => undefined,
      now: (() => {
        let value = 0;
        return () => ++value;
      })(),
    });
    expect((await session.stop()).stopped).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reports remaining profile processes and never signals their PIDs", async () => {
    const child = new FakeChild();
    const signaledGroups: number[] = [];
    let launched = false;
    const session = await launchOwnedChrome({
      executable: "/Applications/Google Chrome",
      profileDir: "/profiles/wfm",
      startupTimeoutMs: 1,
      stopTimeoutMs: 1,
      spawnChrome: () => {
        launched = true;
        return child;
      },
      listProfilePids: () => (launched ? [4242, 5151] : []),
      signalGroup: (pid) => signaledGroups.push(pid),
      sleep: async () => undefined,
      now: (() => {
        let value = 0;
        return () => ++value;
      })(),
    });
    expect(await session.stop()).toEqual({
      stopped: false,
      remainingProfilePids: [4242, 5151],
    });
    expect(signaledGroups.every((pid) => pid === 4242)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm test -- tests/browser.test.ts
```

Expected: failure because `src/browser.ts` does not exist.

- [ ] **Step 3: Add browser session types**

Append to `src/types.ts`:

```ts
export interface BrowserStopResult {
  stopped: boolean;
  remainingProfilePids: number[];
}

export interface OwnedChromeSession {
  pid: number;
  stop(): Promise<BrowserStopResult>;
}
```

- [ ] **Step 4: Implement profile discovery and owned launch**

Create `src/browser.ts` with these public types and constants:

```ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type {
  BrowserStopResult,
  OwnedChromeSession,
} from "./types.js";

export type ExecFileText = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "ignore"] },
) => string;

type SpawnChrome = (
  executable: string,
  args: string[],
  options: {
    detached: true;
    stdio: "ignore";
  },
) => Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">;

export interface LaunchChromeInput {
  executable: string;
  profileDir: string;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  launchUrl?: string;
  spawnChrome?: SpawnChrome;
  listProfilePids?: () => number[];
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const POLL_MS = 100;
const DEFAULT_URL = "https://www.amazon.com/wholefoods";

export class BrowserLaunchError extends Error {
  constructor(
    message: string,
    readonly requiresLockRetention: boolean,
  ) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}
```

Implement `listProfileProcessIds` by running `ps -axo pid=,command=` and selecting only lines containing the exact token:

```ts
export function listProfileProcessIds(
  profileDir: string,
  execFile: ExecFileText = execFileSync,
): number[] {
  const output = execFile(
    "ps",
    ["-axo", "pid=,command="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const marker = `--user-data-dir=${profileDir}`;
  return output
    .split("\\n")
    .filter((line) => line.includes(marker))
    .map((line) => Number(/^\\s*(\\d+)/.exec(line)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
```

Implement `launchOwnedChrome` with this exact lifecycle:

1. Call `listProfilePids`; when it is nonempty, throw
   `new BrowserLaunchError(\`Dedicated Chrome profile is already active: ${existingPids.join(", ")}\`, false)`.
   This run did not launch or own those processes, so it may release its cart
   lock.
2. Spawn with:

```ts
[
  `--user-data-dir=${input.profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  input.launchUrl ?? DEFAULT_URL,
]
```

and `{ detached: true, stdio: "ignore" }`.
3. Reject if no positive child PID.
4. Poll until either the child PID appears in `listProfilePids`, the child exits, or startup timeout expires.
5. On startup failure, signal only `-ownedPid` with `SIGTERM`, poll, then `SIGKILL`, and throw `BrowserLaunchError`. Set `requiresLockRetention` to `true` only when the final profile check still finds processes; include those PIDs in the token-free message.
6. Make `stop()` idempotent. Signal the owned process group with `SIGTERM`, poll for an empty profile process list until `stopTimeoutMs`, signal the same owned group with `SIGKILL`, and poll once more for `stopTimeoutMs`.
7. Return `{ stopped: remainingProfilePids.length === 0, remainingProfilePids }`.
8. Do not signal any PID returned by profile discovery directly. The only signal target is the negative owned process-group leader.

The default group signal implementation is:

```ts
const defaultSignalGroup = (
  pid: number,
  signal: NodeJS.Signals,
): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The owned group may already be gone; profile discovery decides safety.
  }
};
```

- [ ] **Step 5: Run focused validation**

Run:

```bash
npm test -- tests/browser.test.ts
npm run typecheck
```

Expected: both pass, including refusal to signal the synthetic unowned PID `5151`.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts src/types.ts tests/browser.test.ts
git commit -m "feat: manage owned Chrome lifecycle"
```

---

### Task 3: Extension-Mode Codex Invocation

**Files:**
- Modify: `src/codex.ts`
- Modify: `tests/codex.test.ts`

**Interfaces:**
- Consumes: `rootDir`, `browserOutputDir`, `reportPath`, `schemaPath`, `playwrightMcpBin`, and `playwrightMcpShim`.
- Produces: unchanged `buildCodexInvocation(input): CodexInvocation`, with MCP command set to the shim and MCP args set to `[playwrightMcpBin, browserOutputDir]`.
- Removes `profileDir` from `CodexInvocationInput`.

- [ ] **Step 1: Replace the invocation assertions with extension-shim assertions**

Update both `buildCodexInvocation` calls in `tests/codex.test.ts`:

```ts
const invocation = buildCodexInvocation({
  rootDir: "/repo",
  browserOutputDir: "/repo/runs/id/browser",
  reportPath: "/repo/runs/id/report.json",
  schemaPath: "/repo/schemas/report.schema.json",
  playwrightMcpBin: "/repo/node_modules/.bin/playwright-mcp",
  playwrightMcpShim: "/repo/scripts/playwright-extension-mcp.sh",
});
```

Replace the browser argument assertions in the safety test with:

```ts
expect(joined).toContain(
  'mcp_servers.playwright.command="/repo/scripts/playwright-extension-mcp.sh"',
);
expect(joined).toContain(
  'mcp_servers.playwright.args=["/repo/node_modules/.bin/playwright-mcp","/repo/runs/id/browser"]',
);
expect(joined).not.toContain("--browser=chrome");
expect(joined).not.toContain("--user-data-dir");
expect(joined).not.toContain("--cdp-endpoint");
expect(joined).not.toContain("--storage-state");
expect(joined).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
expect(joined).not.toContain("--extension");
```

The final assertion is intentional: `--extension` belongs inside the trusted shim, not in Codex arguments.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm test -- tests/codex.test.ts -t "Codex invocation"
```

Expected: failure because the current invocation still contains `--browser=chrome` and `--user-data-dir`.

- [ ] **Step 3: Implement shim-based invocation**

Change `CodexInvocationInput` to:

```ts
export interface CodexInvocationInput {
  rootDir: string;
  browserOutputDir: string;
  reportPath: string;
  schemaPath: string;
  playwrightMcpBin: string;
  playwrightMcpShim: string;
}
```

Replace the current `mcpArgs` block with:

```ts
const mcpArgs = [
  input.playwrightMcpBin,
  input.browserOutputDir,
];
```

Change only the MCP command configuration line:

```ts
`mcp_servers.playwright.command=${JSON.stringify(input.playwrightMcpShim)}`,
```

Keep all other Codex flags, process-group cleanup, timeout handling, log permissions, and stdin prompt behavior unchanged.

- [ ] **Step 4: Run focused and process-cleanup tests**

Run:

```bash
npm test -- tests/codex.test.ts
npm run typecheck
```

Expected: all Codex invocation, timeout, abort, descendant reaping, and log tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex.ts tests/codex.test.ts
git commit -m "feat: attach Codex through extension shim"
```

---

### Task 4: Harmless Attachment and Auth-Only Contracts

**Files:**
- Create: `schemas/auth-report.schema.json`
- Create: `schemas/attachment-report.schema.json`
- Create: `prompts/auth-check.md`
- Create: `prompts/attachment-check.md`
- Create: `tests/fixtures/valid-auth-report.json`
- Create: `tests/fixtures/valid-attachment-report.json`
- Modify: `src/types.ts`
- Modify: `src/validation.ts`
- Modify: `src/prompt.ts`
- Modify: `tests/validation.test.ts`
- Modify: `tests/prompt.test.ts`

**Interfaces:**
- Produces:
  - `AuthReport`
  - `AttachmentReport`
  - `parseAuthReport(text: string): AuthReport`
  - `assertAuthReportSafe(report: AuthReport): void`
  - `parseAttachmentReport(text: string): AttachmentReport`
  - `assertAttachmentReportSafe(report: AttachmentReport): void`
  - `renderAuthPrompt(input: AuthPromptInput): string`
  - `renderAttachmentPrompt(): string`
- Success requires `runStatus === "completed"`, all three preflight booleans true, and both safety booleans false.

- [ ] **Step 1: Write failing auth validation and prompt tests**

Append to `tests/validation.test.ts`:

```ts
import {
  assertAttachmentReportSafe,
  assertAuthReportSafe,
  parseAttachmentReport,
  parseAuthReport,
} from "../src/validation.js";

const validAuthReport = () =>
  JSON.parse(
    readFileSync(
      new URL("fixtures/valid-auth-report.json", import.meta.url),
      "utf8",
    ),
  );

describe("auth report validation", () => {
  it("accepts a successful non-mutating auth report", () => {
    const report = parseAuthReport(JSON.stringify(validAuthReport()));
    expect(() => assertAuthReportSafe(report)).not.toThrow();
  });

  it.each([
    ["authenticated", false],
    ["expectedLocationConfirmed", false],
    ["wholeFoodsStorefrontConfirmed", false],
    ["checkoutVisited", true],
    ["settingsChanged", true],
  ] as const)("rejects an unsafe or incomplete %s result", (field, value) => {
    const report = validAuthReport();
    report[field] = value;
    expect(() =>
      assertAuthReportSafe(parseAuthReport(JSON.stringify(report))),
    ).toThrow();
  });

  it("rejects cart-shaped fields", () => {
    const report = { ...validAuthReport(), selections: [] };
    expect(() => parseAuthReport(JSON.stringify(report))).toThrow();
  });
});

describe("harmless attachment report validation", () => {
  it("accepts only the fixed Example Domain result", () => {
    const text = readFileSync(
      new URL("fixtures/valid-attachment-report.json", import.meta.url),
      "utf8",
    );
    expect(() =>
      assertAttachmentReportSafe(parseAttachmentReport(text)),
    ).not.toThrow();
  });

  it("rejects navigation or interaction evidence", () => {
    const report = {
      connected: true,
      url: "https://example.com/",
      title: "Example Domain",
      navigationPerformed: true,
      interactionPerformed: false,
    };
    expect(() =>
      assertAttachmentReportSafe(
        parseAttachmentReport(JSON.stringify(report)),
      ),
    ).toThrow("performed a prohibited action");
  });
});
```

Append to `tests/prompt.test.ts`:

```ts
import {
  renderAttachmentPrompt,
  renderAuthPrompt,
} from "../src/prompt.js";

describe("auth-only prompt", () => {
  it("allows only non-mutating auth and storefront checks", () => {
    const prompt = renderAuthPrompt({
      expectedPostalCode: "00000",
      browserOutputDir: "/repo/runs/id/browser",
    });
    expect(prompt).toContain("Confirm that Amazon is authenticated");
    expect(prompt).toContain("00000");
    expect(prompt).toContain("/repo/runs/id/browser/auth-state.png");
    expect(prompt).toContain("NEVER inspect cart contents");
    expect(prompt).toContain("NEVER search for products");
    expect(prompt).toContain("NEVER add, remove, or change cart items");
    expect(prompt).toContain("NEVER open or enter checkout");
    expect(prompt).toContain("NEVER expose an account name");
    expect(prompt).not.toContain("FOR EACH INGREDIENT");
    expect(prompt).not.toContain("GROCERY REQUEST");
  });
});

describe("harmless attachment prompt", () => {
  it("permits only observation of Example Domain", () => {
    const prompt = renderAttachmentPrompt();
    expect(prompt).toContain("https://example.com");
    expect(prompt).toContain("Do not navigate");
    expect(prompt).toContain("Do not click, type, or submit");
    expect(prompt).not.toContain("Amazon");
    expect(prompt).not.toContain("cart");
  });
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
npm test -- tests/validation.test.ts tests/prompt.test.ts
```

Expected: failure because auth types, schema, parser, safety assertion, prompt file, and renderer do not exist.

- [ ] **Step 3: Add the strict auth report contract**

Append to `src/types.ts`:

```ts
export interface AuthReport {
  runStatus: "completed" | "failed";
  authenticated: boolean;
  expectedLocationConfirmed: boolean;
  wholeFoodsStorefrontConfirmed: boolean;
  checkoutVisited: boolean;
  settingsChanged: boolean;
  failureReason: string | null;
}

export interface AttachmentReport {
  connected: boolean;
  url: "https://example.com/";
  title: "Example Domain";
  navigationPerformed: boolean;
  interactionPerformed: boolean;
}
```

Create `schemas/auth-report.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "runStatus",
    "authenticated",
    "expectedLocationConfirmed",
    "wholeFoodsStorefrontConfirmed",
    "checkoutVisited",
    "settingsChanged",
    "failureReason"
  ],
  "properties": {
    "runStatus": { "enum": ["completed", "failed"] },
    "authenticated": { "type": "boolean" },
    "expectedLocationConfirmed": { "type": "boolean" },
    "wholeFoodsStorefrontConfirmed": { "type": "boolean" },
    "checkoutVisited": { "type": "boolean" },
    "settingsChanged": { "type": "boolean" },
    "failureReason": { "type": ["string", "null"] }
  }
}
```

Create `tests/fixtures/valid-auth-report.json`:

```json
{
  "runStatus": "completed",
  "authenticated": true,
  "expectedLocationConfirmed": true,
  "wholeFoodsStorefrontConfirmed": true,
  "checkoutVisited": false,
  "settingsChanged": false,
  "failureReason": null
}
```

Create `schemas/attachment-report.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "connected",
    "url",
    "title",
    "navigationPerformed",
    "interactionPerformed"
  ],
  "properties": {
    "connected": { "const": true },
    "url": { "const": "https://example.com/" },
    "title": { "const": "Example Domain" },
    "navigationPerformed": { "const": false },
    "interactionPerformed": { "const": false }
  }
}
```

Create `tests/fixtures/valid-attachment-report.json`:

```json
{
  "connected": true,
  "url": "https://example.com/",
  "title": "Example Domain",
  "navigationPerformed": false,
  "interactionPerformed": false
}
```

- [ ] **Step 4: Implement auth parsing and gates**

In `src/validation.ts`, import `AttachmentReport` and `AuthReport`, compile both
new schemas, and add:

```ts
const authReportValidator = compile("../schemas/auth-report.schema.json");
const attachmentReportValidator = compile(
  "../schemas/attachment-report.schema.json",
);

export function parseAttachmentReport(text: string): AttachmentReport {
  const value: unknown = JSON.parse(text);
  if (!attachmentReportValidator(value)) {
    throw new ValidationFailure(
      "attachment report",
      attachmentReportValidator.errors,
    );
  }
  return value as AttachmentReport;
}

export function assertAttachmentReportSafe(
  report: AttachmentReport,
): void {
  if (report.navigationPerformed || report.interactionPerformed) {
    throw new Error("Attachment check performed a prohibited action");
  }
  if (
    !report.connected ||
    report.url !== "https://example.com/" ||
    report.title !== "Example Domain"
  ) {
    throw new Error("Attachment check did not observe Example Domain");
  }
}

export function parseAuthReport(text: string): AuthReport {
  const value: unknown = JSON.parse(text);
  if (!authReportValidator(value)) {
    throw new ValidationFailure("auth report", authReportValidator.errors);
  }
  return value as AuthReport;
}

export function assertAuthReportSafe(report: AuthReport): void {
  if (report.checkoutVisited || report.settingsChanged) {
    throw new Error("Auth check crossed a prohibited safety boundary");
  }
  const missing = (
    [
      ["authenticated", report.authenticated],
      ["expectedLocationConfirmed", report.expectedLocationConfirmed],
      [
        "wholeFoodsStorefrontConfirmed",
        report.wholeFoodsStorefrontConfirmed,
      ],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (report.runStatus !== "completed" || missing.length > 0) {
    throw new Error(
      `Auth check failed${missing.length > 0 ? `: ${missing.join(", ")}` : ""}`,
    );
  }
}
```

Expand `ValidationFailure`'s kind union to:

```ts
"request" | "report" | "auth report" | "attachment report"
```

- [ ] **Step 5: Create and render the fixed auth prompt**

Create `prompts/auth-check.md`:

```md
You are running a non-mutating Whole Foods Market authentication check.

Use only Playwright MCP browser tools and an existing Amazon or Whole Foods tab.

SAFETY RULES:
- NEVER inspect cart contents or cart item counts.
- NEVER search for products.
- NEVER add, remove, or change cart items.
- NEVER open or enter checkout.
- NEVER select a delivery or pickup window.
- NEVER place, submit, change, or cancel an order.
- NEVER change an address, payment setting, account setting, credit, coupon, or promotion.
- NEVER expose an account name, email, street address, order history, or payment detail in the report or screenshot.
- Stop immediately if the page state is uncertain.

CHECKS:
1. Start Playwright tracing.
2. Open or identify an Amazon Whole Foods storefront tab.
3. Confirm that Amazon is authenticated without opening account settings.
4. Confirm the displayed delivery location matches EXPECTED POSTAL CODE.
5. Confirm the Whole Foods Market storefront.
6. Capture only the minimum storefront-header evidence needed for these checks
   at the absolute AUTH SCREENSHOT PATH; exclude account menus and personal
   details.
7. Stop Playwright tracing.
8. Return only JSON matching the supplied auth output schema.

Set checkoutVisited and settingsChanged truthfully. Either must make the run failed.
```

Create `prompts/attachment-check.md`:

```md
You are running a harmless Playwright Extension attachment check.

Use Playwright MCP only to inspect the tab already opened at https://example.com.
Do not navigate or open another URL.
Do not click, type, or submit.
Do not capture a screenshot or trace.
Do not inspect browser storage, cookies, history, or other tabs.

Confirm the current URL and page title. Return only JSON matching the supplied
attachment output schema. Set navigationPerformed and interactionPerformed
truthfully; either must make the run failed.
```

In `src/prompt.ts`, load the second template once and add:

```ts
export interface AuthPromptInput {
  expectedPostalCode: string;
  browserOutputDir: string;
}

export function renderAuthPrompt(input: AuthPromptInput): string {
  return [
    authTemplate.trim(),
    "",
    `EXPECTED POSTAL CODE: ${input.expectedPostalCode}`,
    `BROWSER OUTPUT DIRECTORY: ${input.browserOutputDir}`,
    `AUTH SCREENSHOT PATH: ${join(input.browserOutputDir, "auth-state.png")}`,
    "",
  ].join("\\n");
}
```

Import `join` from `node:path` if it is not already imported. Load the template
with:

```ts
const authTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/auth-check.md", import.meta.url)),
  "utf8",
);
```

Load the harmless template beside it:

```ts
const attachmentTemplate = readFileSync(
  fileURLToPath(new URL("../prompts/attachment-check.md", import.meta.url)),
  "utf8",
);

export function renderAttachmentPrompt(): string {
  return `${attachmentTemplate.trim()}\\n`;
}
```

- [ ] **Step 6: Run focused validation**

Run:

```bash
npm test -- tests/validation.test.ts tests/prompt.test.ts
npm run typecheck
```

Expected: all schema, gate, and non-mutation prompt tests pass.

- [ ] **Step 7: Commit**

```bash
git add schemas/auth-report.schema.json schemas/attachment-report.schema.json prompts/auth-check.md prompts/attachment-check.md tests/fixtures/valid-auth-report.json tests/fixtures/valid-attachment-report.json src/types.ts src/validation.ts src/prompt.ts tests/validation.test.ts tests/prompt.test.ts
git commit -m "feat: add attached browser check contracts"
```

---

### Task 5: CLI Browser Lifecycle and Auth-Check Command

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/artifacts.ts`
- Modify: `src/types.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/artifacts.test.ts`

**Interfaces:**
- Consumes:
  - `assertExtensionTokenAvailable`
  - `launchOwnedChrome`
  - `buildCodexInvocation`
  - `renderPrompt` or `renderAuthPrompt`
  - `parseReport` or `parseAuthReport`
- Produces:
  - `runCli(["build", requestPath], dependencies): Promise<number>`
  - `runCli(["auth-check"], dependencies): Promise<number>`
  - `runCli(["attachment-check"], dependencies): Promise<number>`
  - Cleanup order `abort/reap Codex -> stop owned Chrome -> profile idle check -> release lock`.
- Add dependency injection:

```ts
checkExtensionToken?: typeof assertExtensionTokenAvailable;
launchBrowser?: typeof launchOwnedChrome;
```

- [ ] **Step 1: Add failing lifecycle and auth-check integration tests**

Extend `baseEnv` in `tests/cli.test.ts`:

```ts
const baseEnv = (root: string) => ({
  HOME: root,
  USER: "test",
  WFM_EXPECTED_POSTAL_CODE: "00000",
  PLAYWRIGHT_MCP_BIN: "/usr/bin/true",
  PLAYWRIGHT_MCP_SHIM: "/usr/bin/true",
  CHROME_EXECUTABLE: "/usr/bin/true",
});
```

Add test helpers:

```ts
const lifecycleDependencies = (
  root: string,
  events: string[],
  stopResult = { stopped: true, remainingProfilePids: [] as number[] },
) => ({
  rootDir: root,
  env: baseEnv(root),
  checkExtensionToken: () => {
    events.push("token-check");
  },
  launchBrowser: async () => {
    events.push("chrome-start");
    return {
      pid: 4242,
      stop: async () => {
        events.push("chrome-stop");
        return stopResult;
      },
    };
  },
});
```

Update every existing CLI test dependency object to spread this helper so
automated tests never touch Keychain or Chrome:

```ts
const events: string[] = [];
const dependencies = {
  ...lifecycleDependencies(root, events),
  invokeCodex: async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
  }),
};
```

Add these tests:

```ts
it("stops Chrome before releasing the lock on build success", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-cli-life-"));
  const request = writeValidRequest(root);
  const events: string[] = [];
  const exitCode = await runCli(["build", request], {
    ...lifecycleDependencies(root, events),
    invokeCodex: async ({ reportPath, requestSha256 }) => {
      events.push("codex");
      writeReport(reportPath, requestSha256);
      return { exitCode: 0, signal: null, timedOut: false };
    },
    releaseLock: (lock) => {
      events.push("lock-release");
      lock.release();
    },
  });
  expect(exitCode).toBe(0);
  expect(events).toEqual([
    "token-check",
    "chrome-start",
    "codex",
    "chrome-stop",
    "lock-release",
  ]);
});

it.each(["throw", "nonzero", "malformed", "chmod"] as const)(
  "closes owned Chrome after %s failure",
  async (failure) => {
    const root = mkdtempSync(join(tmpdir(), "wfm-cli-cleanup-"));
    const request = writeValidRequest(root);
    const events: string[] = [];
    const exitCode = await runCli(["build", request], {
      ...lifecycleDependencies(root, events),
      secureReport:
        failure === "chmod"
          ? () => {
              throw new Error("chmod failed");
            }
          : undefined,
      invokeCodex: async ({ reportPath, requestSha256 }) => {
        events.push("codex");
        if (failure === "throw") throw new Error("synthetic");
        if (failure === "malformed") writeFileSync(reportPath, "{");
        else writeReport(reportPath, requestSha256);
        return {
          exitCode: failure === "nonzero" ? 1 : 0,
          signal: null,
          timedOut: false,
        };
      },
    });
    expect(exitCode).not.toBe(0);
    expect(events.at(-1)).toBe("chrome-stop");
  },
);

it("retains the lock when Chrome cannot be confirmed stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-cli-stuck-"));
  const request = writeValidRequest(root);
  const lockPath = join(root, ".wfm-cart.lock");
  const events: string[] = [];
  const exitCode = await runCli(["build", request], {
    ...lifecycleDependencies(root, events, {
      stopped: false,
      remainingProfilePids: [4242],
    }),
    invokeCodex: async ({ reportPath, requestSha256 }) => {
      writeReport(reportPath, requestSha256);
      return { exitCode: 0, signal: null, timedOut: false };
    },
  });
  expect(exitCode).toBe(2);
  expect(existsSync(lockPath)).toBe(true);
  expect(readFileSync(lockPath, "utf8")).toMatch(/^\\d+\\n$/);
});

it("runs auth-check with no grocery request or cart instructions", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-auth-check-"));
  const events: string[] = [];
  let prompt = "";
  const exitCode = await runCli(["auth-check"], {
    ...lifecycleDependencies(root, events),
    invokeCodex: async ({ reportPath, prompt: value }) => {
      prompt = value;
      writeFileSync(
        reportPath,
        readFileSync(
          new URL("fixtures/valid-auth-report.json", import.meta.url),
          "utf8",
        ),
        { mode: 0o600 },
      );
      return { exitCode: 0, signal: null, timedOut: false };
    },
  });
  expect(exitCode).toBe(0);
  expect(prompt).toContain("NEVER inspect cart contents");
  expect(prompt).not.toContain("GROCERY REQUEST");
  expect(events).toContain("chrome-stop");
});

it("returns 1 when auth-check reports signed out", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-auth-fail-"));
  const events: string[] = [];
  const exitCode = await runCli(["auth-check"], {
    ...lifecycleDependencies(root, events),
    invokeCodex: async ({ reportPath }) => {
      const report = JSON.parse(
        readFileSync(
          new URL("fixtures/valid-auth-report.json", import.meta.url),
          "utf8",
        ),
      );
      Object.assign(report, {
        runStatus: "failed",
        authenticated: false,
        failureReason: "Amazon is signed out",
      });
      writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
      return { exitCode: 0, signal: null, timedOut: false };
    },
  });
  expect(exitCode).toBe(1);
  expect(events).toContain("chrome-stop");
});

it("owns the harmless Example Domain attachment lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-attachment-check-"));
  const events: string[] = [];
  let launchUrl = "";
  const dependencies = lifecycleDependencies(root, events);
  const exitCode = await runCli(["attachment-check"], {
    ...dependencies,
    launchBrowser: async (input) => {
      launchUrl = input.launchUrl ?? "";
      return dependencies.launchBrowser();
    },
    invokeCodex: async ({ reportPath, prompt }) => {
      expect(prompt).toContain("https://example.com");
      expect(prompt).not.toContain("Amazon");
      writeFileSync(
        reportPath,
        readFileSync(
          new URL("fixtures/valid-attachment-report.json", import.meta.url),
          "utf8",
        ),
        { mode: 0o600 },
      );
      return { exitCode: 0, signal: null, timedOut: false };
    },
  });
  expect(exitCode).toBe(0);
  expect(launchUrl).toBe("https://example.com");
  expect(events).toContain("chrome-stop");
});
```

If TypeScript rejects an explicitly `undefined` optional property under `exactOptionalPropertyTypes`, build the dependency object conditionally:

```ts
const secureDependency =
  failure === "chmod"
    ? { secureReport: () => { throw new Error("chmod failed"); } }
    : {};
```

- [ ] **Step 2: Run the CLI tests to verify RED**

Run:

```bash
npm test -- tests/cli.test.ts
```

Expected: failures because CLI dependencies lack browser/token hooks, `auth-check` is unsupported, and lock retention is not implemented.

- [ ] **Step 3: Generalize run artifacts for auth-check**

Add to `RunPaths` in `src/types.ts`:

```ts
kind: "build" | "auth-check" | "attachment-check";
```

Change `createRunPaths` in `src/artifacts.ts`:

```ts
export function createRunPaths(
  rootDir: string,
  now = new Date(),
  kind: RunPaths["kind"] = "build",
): RunPaths {
```

Set `kind` in the returned object. All three commands continue using owner-only
run directories, `report.json`, Codex logs, and `browser/`. Only `build` calls
`writeRequestSnapshot`, `canonicalRequest`, `sha256`, `findPreviousReport`, and
`assertReportMatchesRequest`.

Add to `tests/artifacts.test.ts`:

```ts
it("creates an auth-check run without requiring a request path", () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-auth-"));
  const paths = createRunPaths(
    root,
    new Date("2026-09-12T12:34:56Z"),
    "auth-check",
  );
  expect(paths.kind).toBe("auth-check");
  expect(paths.reportPath).toContain("/runs/");
  expect(paths.browserOutputDir).toContain("/browser");
});
```

- [ ] **Step 4: Refactor CLI around one lifecycle**

In `src/cli.ts`, extend `CliDependencies` with:

```ts
checkExtensionToken?: typeof assertExtensionTokenAvailable;
launchBrowser?: typeof launchOwnedChrome;
releaseLock?: (lock: RunLock) => void;
```

Resolve defaults once:

```ts
const checkExtensionToken =
  dependencies.checkExtensionToken ?? assertExtensionTokenAvailable;
const launchBrowser =
  dependencies.launchBrowser ?? launchOwnedChrome;
const releaseLock =
  dependencies.releaseLock ?? ((lock: RunLock) => lock.release());
```

Before acquiring the lock, validate that these paths exist and are executable:

```ts
config.chromeExecutable
config.playwrightMcpBin
config.playwrightMcpShim
```

Use `accessSync(path, constants.X_OK)` for each path and translate failures to
`<label> is missing or not executable: <absolute path>` without including
environment contents. Import `accessSync` and `constants` from `node:fs`.

Call the token check without reading its value:

```ts
checkExtensionToken({
  account: config.keychainAccount,
  service: config.keychainService,
});
```

After acquiring the lock and creating run paths, launch:

```ts
browser = await launchBrowser({
  executable: config.chromeExecutable,
  profileDir: config.profileDir,
  startupTimeoutMs: config.chromeStartupTimeoutMs,
  stopTimeoutMs: config.chromeStopTimeoutMs,
  launchUrl:
    command === "attachment-check"
      ? "https://example.com"
      : "https://www.amazon.com/wholefoods",
});
```

Catch `BrowserLaunchError` inside the lock scope. Call `lock.retain()` and
return `2` when `requiresLockRetention` is true; otherwise call
`lock.release()` and return `2`. Other launch errors follow the conservative
retention path because the CLI cannot prove whether the profile is idle.

Build the Codex invocation with:

```ts
playwrightMcpBin: config.playwrightMcpBin,
playwrightMcpShim: config.playwrightMcpShim,
```

Remove `profileDir` from that call.

Refactor early returns inside the lock scope to assign an `exitCode` local.
After command-specific work settles, use one `finally` whose final section is
ordered:

```ts
let retainLock = false;
let cleanupFailed = false;

try {
  try {
    secureReport(paths.reportPath);
  } catch (error) {
    cleanupFailed = true;
    console.error(error instanceof Error ? error.message : String(error));
  }
  if (browser) {
    const stopped = await browser.stop();
    if (!stopped.stopped) {
      retainLock = true;
      cleanupFailed = true;
      console.error(
        `Chrome still uses the dedicated profile (PIDs: ${stopped.remainingProfilePids.join(", ")}). Confirm those processes are gone, then manually remove ${lockPath}.`,
      );
    }
  }
} finally {
  if (!retainLock) {
    releaseLock(lock);
  } else {
    lock.retain();
  }
}
if (cleanupFailed) exitCode = 2;
return exitCode;
```

`invokeCodex` must have settled before `browser.stop()` begins. Preserve the existing abort signal forwarding so timeout, `SIGINT`, and `SIGTERM` first terminate Codex's process group.

Dispatch command-specific behavior:

- `build <request.json>` keeps all current request hash, prior report, cart report, preflight, safety, and exit-code logic.
- `auth-check` accepts no positional argument, uses `schemas/auth-report.schema.json`, `renderAuthPrompt`, `parseAuthReport`, and `assertAuthReportSafe`.
- `attachment-check` accepts no positional argument, opens only
  `https://example.com`, uses `schemas/attachment-report.schema.json`,
  `renderAttachmentPrompt`, `parseAttachmentReport`, and
  `assertAttachmentReportSafe`, and never captures a screenshot or trace.
- Preserve `InvokeInput.requestSha256: string` for existing test doubles by passing `sha256("auth-check")` for auth runs; the auth schema does not expose or validate that internal value.
- Pass `sha256("attachment-check")` through the same internal test seam for the harmless command.
- Auth `runStatus: "failed"` or a false required gate returns `1`.
- Catch `assertAuthReportSafe` failures inside the auth branch, print a token-free auth failure message, and return `1`; reserve the outer `2` path for invalid JSON/schema and orchestration failures.
- Invalid args, missing prerequisites, invalid JSON/schema, cleanup failure, or retained lock returns `2`.
- Cart safety flags retain their current exit behavior.

Update the usage message to:

```text
usage: cart build <request.json>
       cart auth-check
       cart attachment-check
```

- [ ] **Step 5: Preserve lock ownership on intentional retention**

Do not change `acquireRunLock`'s successful-release closure. The CLI retains a stuck-browser lock by deliberately not calling that closure. Because the descriptor remains open only until Node exits, ensure `acquireRunLock` exposes a separate close-without-unlink path:

```ts
export interface RunLock {
  release(): void;
  retain(): void;
}
```

Refactor `src/lock.ts`:

```ts
export function acquireRunLock(path: string): RunLock {
  let descriptor = openSync(path, "wx", 0o600);
  let closed = false;
  writeFileSync(descriptor, `${process.pid}\n`);
  const close = (): void => {
    if (closed) return;
    closeSync(descriptor);
    closed = true;
  };
  return {
    release() {
      close();
      unlinkSync(path);
    },
    retain() {
      close();
    },
  };
}
```

Update `tests/lock.test.ts` to call `.release()` and add:

```ts
it("can retain a recovery lock while closing its descriptor", () => {
  const root = mkdtempSync(join(tmpdir(), "wfm-lock-retain-"));
  const path = join(root, ".wfm-cart.lock");
  const lock = acquireRunLock(path);
  lock.retain();
  expect(readFileSync(path, "utf8")).toMatch(/^\\d+\\n$/);
  expect(() => acquireRunLock(path)).toThrow("already running");
});
```

The CLI `releaseLock` test seam receives the `RunLock` object and defaults to
`lock.release()`. On stuck Chrome call `lock.retain()` instead.

- [ ] **Step 6: Run integration and regression tests**

Run:

```bash
npm test -- tests/lock.test.ts tests/artifacts.test.ts tests/cli.test.ts
npm test
npm run typecheck
```

Expected: all tests pass. Verify the timeout and abort tests still observe Codex cancellation before `chrome-stop`, and no test launches a real browser or calls Keychain.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/artifacts.ts src/types.ts src/lock.ts tests/cli.test.ts tests/artifacts.test.ts tests/lock.test.ts
git commit -m "feat: orchestrate attached browser runs"
```

---

### Task 6: Operator Documentation and Staged Acceptance Gates

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-test-runbook.md`

**Interfaces:**
- Documents exact setup and recovery commands.
- Does not run Amazon or cart actions as part of automated verification.

- [ ] **Step 1: Add setup and normal-use documentation**

Add a section to `README.md` with these exact operator steps:

```md
## Attached browser authentication

The cart command launches and owns a dedicated normal Chrome instance at
`~/.whole-foods-cart/chrome-profile`. It never attaches to the everyday Chrome
profile.

1. Run `npm run login`.
2. In that dedicated Chrome profile, install Microsoft's official Playwright
   MCP Browser Extension.
3. Sign in to Amazon and select the intended Whole Foods delivery location.
4. Copy the extension token, then run `npm run setup-extension-token`. Paste
   the token only into the hidden macOS Keychain prompt.
5. Close the dedicated Chrome window.
6. Run `npm run cart -- attachment-check` to verify the extension against
   Example Domain without opening Amazon.
7. Run `npm run auth-check`.
8. After the auth check succeeds, run
   `npm run cart -- build path/to/request.json`.

The CLI starts Chrome on demand and closes only the instance it launched.
Codex receives neither the extension token nor the Keychain lookup command.

### Recovery lock

If the CLI says Chrome still uses the dedicated profile, it intentionally
leaves `.wfm-cart.lock` in place. Do not remove it while any process uses
`~/.whole-foods-cart/chrome-profile`.

Inspect first:

```bash
ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'
```

After confirming that no matching Chrome process remains:

```bash
rm .wfm-cart.lock
```

Never export cookies or Playwright storage state. Never use the everyday Chrome
profile for this POC.
```

Keep `WFM_EXPECTED_POSTAL_CODE` documented only as an environment variable with
the non-routable test value `00000`; do not add the user's actual postal code.

- [ ] **Step 2: Add the manual gate sequence**

Add to `docs/manual-test-runbook.md`:

```md
## Attached-browser acceptance

Run gates in order and stop on the first failure.

### Gate 1: extension and Keychain setup

- Open only the dedicated profile with `npm run login`.
- Install the official Playwright MCP Browser Extension in that profile.
- Sign in to Amazon manually.
- Run `npm run setup-extension-token`.
- Confirm `security find-generic-password -a "$USER" -s "whole-foods-cart.playwright-extension"` succeeds without `-w`.
- Close the dedicated browser.

### Gate 2: harmless public-page attachment

- Confirm the dedicated profile is closed.
- Run `npm run cart -- attachment-check`.
- Confirm the report contains only `connected: true`,
  `url: "https://example.com/"`, `title: "Example Domain"`,
  `navigationPerformed: false`, and `interactionPerformed: false`.
- Confirm the command closes the dedicated Chrome window and
  `ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'`
  finds no Chrome process.
- Confirm `.wfm-cart.lock` is absent.
- Do not browse Amazon in this gate.

### Gate 3: non-mutating Amazon auth check

- Obtain explicit operator approval to use the live authenticated account.
- Run `npm run auth-check`.
- Confirm `authenticated`, `expectedLocationConfirmed`, and
  `wholeFoodsStorefrontConfirmed` are true.
- Confirm `checkoutVisited` and `settingsChanged` are false.
- Confirm no cart contents were read or changed.

### Gate 4: external-action reconfirmation

- Explain that generic browser control is acting on a funded Amazon account.
- Reconfirm that the next gate may add products to the Whole Foods cart.
- Do not proceed without explicit approval.

### Gate 5: supervised three-item smoke

- Use the approved three-item fixture only.
- Run one foreground build while observing the dedicated Chrome window.
- Stop immediately on checkout, settings, location, or storefront uncertainty.
- Confirm the report and current cart delta match exactly.

### Gate 6: larger fixtures

- Proceed only after Gate 5 succeeds.
- Reconsider, rather than automatically run, three 10-item fixtures and one
  controlled idempotency run.
```

- [ ] **Step 3: Run documentation and full static validation**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: every command passes. Review output to ensure no token, cookie, account data, or real postal code appears.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/manual-test-runbook.md
git commit -m "docs: explain attached browser setup"
```

---

### Task 7: Final Offline Review and Manual Gate Handoff

**Files:**
- Review only: all changed files

**Interfaces:**
- Produces verified offline implementation and a clear stop before live account actions.

- [ ] **Step 1: Review the complete branch for forbidden credential paths**

Run:

```bash
rg -n "PLAYWRIGHT_MCP_EXTENSION_TOKEN|find-generic-password|storage-state|user-data-dir|cdp-endpoint" src scripts tests README.md docs package.json
```

Expected:

- `PLAYWRIGHT_MCP_EXTENSION_TOKEN` appears only in the trusted shim and tests proving absence from Codex arguments.
- `find-generic-password` appears only in Keychain code, setup/shim scripts, tests, and operator documentation.
- `storage-state` and `cdp-endpoint` appear only in negative assertions or documentation forbidding them.
- `user-data-dir` appears in the Chrome owner, login/setup path, process-discovery tests, negative MCP assertions, and documentation, never in Codex MCP arguments.

- [ ] **Step 2: Run complete offline verification**

Run:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
git status --short
```

Expected: install, lint, typecheck, all tests, build, and whitespace checks pass. `git status --short` is clean after committed tasks.

- [ ] **Step 3: Perform code review**

Use `superpowers:requesting-code-review` against the design spec and this plan. Require the reviewer to check:

- only the owned process group can be signaled;
- pre-existing profile processes cause failure before launch;
- every Codex outcome closes Chrome;
- browser-stop failure retains the lock;
- token values cannot enter arguments, prompts, events, stderr, or artifacts;
- auth-check instructions cannot inspect or mutate the cart;
- existing build report and checkout safety behavior remains intact.

Fix any high-confidence findings with TDD, rerun Step 2, and commit each coherent fix.

- [ ] **Step 4: Stop before live acceptance**

Report the offline verification results and ask the operator for explicit approval before Gate 2. Gate 2 may open only `https://example.com`. Ask again before Gate 3 because it reads a live authenticated Amazon session. Ask again before Gate 5 because it mutates the cart.

Do not combine these approvals and do not run Gate 5 merely because implementation is complete.
