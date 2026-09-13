import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock } from "../src/lock.js";

describe("run lock", () => {
  it("rejects a second job and releases after completion", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wfm-lock-")), "run.lock");
    const release = acquireRunLock(path);
    expect(() => acquireRunLock(path)).toThrow(/already running/);
    release();
    expect(existsSync(path)).toBe(false);
  });
});
