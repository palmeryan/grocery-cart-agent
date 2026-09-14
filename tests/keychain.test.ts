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
