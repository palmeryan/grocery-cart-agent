import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRunLock } from "../src/lock.js";

describe("run lock", () => {
  it("rejects a second job and releases after completion", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wfm-lock-")), "run.lock");
    const lock = acquireRunLock(path);
    expect(() => acquireRunLock(path)).toThrow(/still running/);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("can retain a recovery lock while closing its descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-lock-retain-"));
    const path = join(root, ".wfm-cart.lock");
    const lock = acquireRunLock(path);
    lock.retain();
    expect(readFileSync(path, "utf8")).toMatch(/^\d+\n$/);
    expect(() => acquireRunLock(path)).toThrow("still running");
  });

  it("removes a stale lock only after confirming the profile is unused", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-lock-stale-"));
    const path = join(root, ".wfm-cart.lock");
    writeFileSync(path, "54321\n");
    const lock = acquireRunLock(path, {
      profileDir: join(root, "profile"),
      isPidAlive: () => false,
      listProfilePids: () => [],
    });
    expect(readFileSync(path, "utf8")).toMatch(/^\d+\n$/);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps the lock when a dedicated-profile Chrome process remains", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-lock-profile-active-"));
    const path = join(root, ".wfm-cart.lock");
    writeFileSync(path, "54321\n");
    expect(() => acquireRunLock(path, {
      profileDir: join(root, "profile"),
      isPidAlive: () => false,
      listProfilePids: () => [876],
    })).toThrow(/Chrome still uses the dedicated profile.*876/);
    expect(readFileSync(path, "utf8")).toBe("54321\n");
  });

  it("keeps malformed or unverifiable locks for manual inspection", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-lock-invalid-"));
    const path = join(root, ".wfm-cart.lock");
    writeFileSync(path, "not-a-pid\n");
    expect(() => acquireRunLock(path, {
      profileDir: join(root, "profile"),
      isPidAlive: () => false,
      listProfilePids: () => [],
    })).toThrow(/invalid contents/);
    expect(readFileSync(path, "utf8")).toBe("not-a-pid\n");

    writeFileSync(path, "54321\n");
    expect(() => acquireRunLock(path, {
      profileDir: join(root, "profile"),
      isPidAlive: () => false,
      listProfilePids: () => { throw new Error("ps unavailable"); },
    })).toThrow(/Could not check Chrome processes/);
    expect(readFileSync(path, "utf8")).toBe("54321\n");
  });

  it("serializes competing stale-lock recovery attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "wfm-lock-race-"));
    const path = join(root, ".wfm-cart.lock");
    writeFileSync(path, "54321\n");
    let competingError = "";
    const lock = acquireRunLock(path, {
      profileDir: join(root, "profile"),
      isPidAlive: () => false,
      listProfilePids: () => {
        try {
          acquireRunLock(path, {
            profileDir: join(root, "profile"),
            isPidAlive: () => false,
            listProfilePids: () => [],
          });
        } catch (error) {
          competingError = error instanceof Error ? error.message : String(error);
        }
        return [];
      },
    });
    expect(competingError).toMatch(/recovery is already underway/);
    expect(existsSync(`${path}.recovery`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    lock.release();
  });
});
