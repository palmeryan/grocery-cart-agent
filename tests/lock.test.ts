import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock } from "../src/lock.js";

describe("run lock", () => {
  it("rejects a second job and releases after completion", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wfm-lock-")), "run.lock");
    const lock = acquireRunLock(path);
    expect(() => acquireRunLock(path)).toThrow(/already running/);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("can retain a recovery lock while closing its descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-lock-retain-"));
    const path = join(root, ".wfm-cart.lock");
    const lock = acquireRunLock(path);
    lock.retain();
    expect(readFileSync(path, "utf8")).toMatch(/^\d+\n$/);
    expect(() => acquireRunLock(path)).toThrow("already running");
  });
});
