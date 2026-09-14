import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";

export interface RunLock {
  release(): void;
  retain(): void;
}

export function acquireRunLock(path: string): RunLock {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    throw new Error(
      `A Whole Foods cart job is already running or left a lock at ${path}`,
    );
  }
  writeFileSync(descriptor, `${process.pid}\n`);
  let closed = false;
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
