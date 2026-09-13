import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinVersion = "5.9.2";

// typescript-eslint@8 hard-fails on TS 7 and also breaks on missing Extension enums.
// Nest a supported TS 5.x under every package that imports typescript at runtime.
const targets = [
  path.join(root, "node_modules", "typescript-eslint"),
  path.join(root, "node_modules", "@typescript-eslint", "eslint-plugin"),
  path.join(root, "node_modules", "@typescript-eslint", "parser"),
  path.join(root, "node_modules", "@typescript-eslint", "typescript-estree"),
  path.join(root, "node_modules", "@typescript-eslint", "utils"),
  path.join(root, "node_modules", "@typescript-eslint", "type-utils"),
  path.join(root, "node_modules", "@typescript-eslint", "project-service"),
  path.join(root, "node_modules", "@typescript-eslint", "tsconfig-utils"),
  path.join(root, "node_modules", "ts-api-utils"),
];

function readVersion(pkgRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

const existingTargets = targets.filter((targetDir) =>
  fs.existsSync(path.join(targetDir, "package.json")),
);

if (existingTargets.length === 0) {
  console.warn("pin-eslint-typescript: typescript-eslint packages not installed; skipping");
  process.exit(0);
}

const alreadyPinned = existingTargets.every((targetDir) => {
  const nestedTs = path.join(targetDir, "node_modules", "typescript");
  if (readVersion(nestedTs) !== pinVersion) return false;
  const nestedRequire = createRequire(path.join(targetDir, "package.json"));
  return nestedRequire("typescript/package.json").version === pinVersion;
});

if (alreadyPinned) {
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfm-ts-pin-"));
try {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", `typescript@${pinVersion}`, "--pack-destination", tmp],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }

  const tarballName = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!tarballName) {
    console.error("pin-eslint-typescript: npm pack produced no tarball name");
    process.exit(1);
  }

  const tarball = path.join(tmp, tarballName);
  const extractDir = path.join(tmp, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", extractDir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    console.error(extract.stderr);
    process.exit(extract.status ?? 1);
  }

  const packageDir = path.join(extractDir, "package");
  if (readVersion(packageDir) !== pinVersion) {
    console.error(
      `pin-eslint-typescript: packed typescript version mismatch: ${readVersion(packageDir)}`,
    );
    process.exit(1);
  }

  for (const targetDir of existingTargets) {
    const nestedTs = path.join(targetDir, "node_modules", "typescript");
    fs.rmSync(nestedTs, { recursive: true, force: true });
    copyDir(packageDir, nestedTs);
    const nestedRequire = createRequire(path.join(targetDir, "package.json"));
    const resolvedVersion = nestedRequire("typescript/package.json").version;
    if (resolvedVersion !== pinVersion) {
      console.error(
        `pin-eslint-typescript: expected ${path.relative(root, targetDir)} to resolve typescript@${pinVersion}, got ${resolvedVersion}`,
      );
      process.exit(1);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `pin-eslint-typescript: nested typescript@${pinVersion} under ${existingTargets
    .map((targetDir) => path.relative(root, targetDir))
    .join(", ")}`,
);
