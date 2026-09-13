import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";

export function acquireRunLock(path: string): () => void {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    throw new Error(
      `A Whole Foods cart job is already running or left a lock at ${path}`,
    );
  }
  writeFileSync(descriptor, `${process.pid}\n`);
  return () => {
    closeSync(descriptor);
    unlinkSync(path);
  };
}
