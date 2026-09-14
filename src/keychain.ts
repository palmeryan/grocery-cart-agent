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
