# Attached-Browser Authentication Design

**Date:** 2026-09-13
**Status:** Approved for implementation planning

## Problem

The Whole Foods cart POC currently launches Google Chrome through Playwright
MCP with a dedicated `--user-data-dir`. A user completed Amazon login in that
same profile, but two later MCP launches showed an unauthenticated session.
Delivery-location state persisted, while Amazon authentication did not. The
cart smoke gate therefore failed before product matching could be evaluated.

The harness needs to reuse an Amazon session that is already live in Chrome
instead of replaying profile state in a Playwright-launched browser.

## Research Summary

Three approaches were evaluated:

1. **Playwright Extension attachment.** Microsoft documents this mode for
   existing tabs, cookies, SSO, 2FA, and browser state. It connects Playwright
   MCP to an already-running Chrome profile.
2. **Chrome channel/CDP attachment.** Chrome 144+ supports an explicit
   `chrome://inspect/#remote-debugging` consent flow, and Playwright MCP can
   connect with `--cdp-endpoint=chrome`. Chrome intentionally requires an
   Allow/Deny prompt for each connection, which conflicts with unattended
   per-run MCP startup.
3. **Dedicated-profile relaunch or exported storage state.** The relaunch path
   already failed for this Amazon account. Playwright warns that a storage-state
   file can impersonate the account, making it a poor standing credential for a
   funded personal Amazon account.

The selected approach is **Playwright Extension attachment to an on-demand,
dedicated Chrome instance**. Chrome, not Playwright, launches the profile.
Playwright MCP attaches after the authenticated browser is running.

Primary sources:

- <https://playwright.dev/mcp/configuration/browser-extension>
- <https://playwright.dev/docs/getting-started-mcp>
- <https://playwright.dev/docs/auth>
- <https://developer.chrome.com/blog/remote-debugging-port>
- <https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session>

## Goals

- Launch the dedicated Whole Foods Chrome profile on demand for each run.
- Reuse the exact live Amazon session in that Chrome process.
- Attach Playwright MCP through Microsoft's Playwright Extension.
- Close only the Chrome instance launched by the cart command after every run.
- Keep the extension token out of Git, request/report artifacts, command-line
  arguments, Codex prompts, and Codex's direct environment.
- Preserve existing request/report contracts, cart safeguards, locking,
  read-only Codex sandbox, timeout handling, and `Ctrl-C` cleanup.
- Add a non-mutating authentication check before another cart smoke test.

## Non-Goals

- No checkout, delivery-window, payment, credit, or order actions.
- No cookie database copying or exported Playwright `storageState`.
- No attachment to the user's everyday Chrome profile.
- No cloud browser, scheduling, multiple households, or multi-user support.
- No claim that extension attachment is a hard security boundary.
- No larger acceptance run until an auth check and three-item smoke both pass.

## Security Model

This remains a POC using generic browser control on a funded Amazon account.
Checkout prevention remains prompt-only. The Playwright Extension and its token
can enable powerful control of attached tabs.

Containment rules:

- Use a dedicated Chrome user-data directory containing only the Amazon/Whole
  Foods POC session.
- Install the Playwright Extension only in that dedicated profile.
- Never attach the extension to unrelated tabs.
- Never use the everyday Chrome profile.
- Keep one cart job and one browser instance per dedicated profile.
- Close the dedicated Chrome instance after each run.
- Keep all browser evidence under the sensitive, gitignored run directory.
- Do not enable Playwright storage capabilities or export session state.
- Do not expose a CDP or MCP listener on a network interface.
- Do not use `--dangerously-bypass-approvals-and-sandbox`,
  `--approve-for-me`, or a writable Codex sandbox.

The Keychain shim reduces accidental token disclosure but is not a hard
same-user security boundary. The dominant risk remains generic browser control
of an authenticated commerce account.

## Architecture

```text
request.json
    |
    v
TypeScript CLI
    |-- validates request/config
    |-- checks Keychain item exists
    |-- acquires profile/cart lock
    |-- launches owned dedicated Chrome
    |-- creates sensitive run artifacts
    |
    v
ChatGPT-authenticated Codex CLI (read-only sandbox)
    |
    | stdio MCP
    v
Keychain-reading MCP shim
    |-- reads extension token into memory
    |-- sets token only for its child
    v
Playwright MCP --extension
    |
    v
Playwright Extension in the owned Chrome instance
    |
    v
Amazon Whole Foods tab
```

## Components

### 1. Chrome Session Manager

A new TypeScript module owns the dedicated browser lifecycle.

Responsibilities:

- Resolve the Google Chrome executable and dedicated profile directory.
- Fail before launch if any Chrome process already uses that profile.
- Launch normal Google Chrome with the dedicated `--user-data-dir` and Whole
  Foods storefront URL.
- Record the main Chrome PID/process group as owned by this run.
- Wait for a bounded readiness condition before starting Codex.
- On every return, throw, timeout, `SIGINT`, or `SIGTERM`, stop Codex/MCP first,
  then terminate the owned Chrome instance.
- Send `SIGTERM`, wait for graceful profile flush, then use `SIGKILL` only after
  a bounded grace period.
- Confirm no process still uses the dedicated profile before releasing the
  lock.
- If Chrome cannot be confirmed stopped, retain the lock and emit manual
  recovery instructions. Never auto-delete that lock.

The manager must never attach to or terminate a profile instance that existed
before the command.

### 2. Extension Token Setup

Use one fixed Keychain identity:

- Service: `whole-foods-cart.playwright-extension`
- Account: current macOS username

A setup script invokes:

```bash
security add-generic-password \
  -U \
  -a "$USER" \
  -s "whole-foods-cart.playwright-extension" \
  -w
```

The final `-w` causes `security` to prompt for the token instead of placing it
in process arguments. Do not use `-A`. Setup verifies that the item can be
found without printing its value.

### 3. Keychain-Reading MCP Shim

A small trusted shell script becomes the MCP command configured for Codex.

It:

- uses `set -euo pipefail`, `set +x`, and `umask 077`;
- validates its fixed arguments, including an absolute browser-output path;
- reads the token with
  `security find-generic-password -a "$USER" -s <service> -w`;
- stores it only in a shell variable;
- executes the pinned Playwright MCP binary with
  `PLAYWRIGHT_MCP_EXTENSION_TOKEN` set only for that subprocess;
- uses `--extension`, `--output-dir=<run browser directory>`, and the existing
  Playwright capabilities;
- never prints the token or includes it in process arguments.

The shim communicates with Codex over stdio. It must keep stdout reserved for
the MCP protocol and use token-free stderr messages.

### 4. Codex Invocation

The invocation builder changes only the Playwright connection path:

- Configure the MCP command as the Keychain shim.
- Pass the pinned Playwright MCP binary and absolute browser-output directory
  as shim arguments.
- Add `--extension`.
- Remove MCP's `--browser=chrome` and `--user-data-dir` arguments because MCP
  no longer launches Chrome.
- Do not add `--cdp-endpoint`, `--storage-state`, or network transport.

Preserve:

- `codex exec`;
- ignored user config and strict config;
- ephemeral Codex sessions;
- `--sandbox read-only`;
- JSONL events, output schema, and final report path;
- `approval_policy="never"`;
- Playwright server `default_tools_approval_mode="approve"`;
- process-group timeout and abort cleanup.

The implementation initially keeps pinned `@playwright/mcp` `0.0.80`, which
supports `--extension`. Upgrade only if a harmless compatibility test proves
the current Web Store extension requires a newer pinned MCP version.

### 5. CLI Orchestration

The cart flow becomes:

1. Validate arguments and grocery request.
2. Load configuration and confirm required executables.
3. Confirm the Keychain item exists without reading or printing its value.
4. Acquire `.wfm-cart.lock`.
5. Confirm the dedicated profile is not already active.
6. Create sensitive run paths and prompt.
7. Launch and record the owned Chrome instance.
8. Invoke Codex, the Keychain shim, and Playwright MCP extension mode.
9. Secure and validate the report.
10. Stop Codex/MCP.
11. Gracefully close the owned Chrome instance and confirm it is gone.
12. Release the lock only after confirmed browser shutdown.

Cleanup order is safety-critical: remove browser control before closing Chrome,
and close Chrome before unlocking the profile.

### 6. Authentication Check

Add a separate, non-mutating command:

```bash
npm run cart -- auth-check
```

It uses the same lock, owned-Chrome lifecycle, Keychain shim, extension
attachment, artifact permissions, timeout, and cleanup behavior.

Its fixed prompt permits only:

- opening or identifying an Amazon/Whole Foods tab;
- confirming Amazon authentication;
- confirming the expected delivery postal code;
- confirming the Whole Foods storefront;
- capturing sanitized evidence and returning a structured auth report.

It must not inspect cart contents, search products, add/remove products, enter
checkout, or change any account setting.

Use a dedicated auth-check JSON schema with:

- `runStatus`;
- `authenticated`;
- `expectedLocationConfirmed`;
- `wholeFoodsStorefrontConfirmed`;
- `checkoutVisited`;
- `settingsChanged`;
- `failureReason`.

Success requires the three preflight booleans true and both safety booleans
false.

## Configuration

Add explicit configuration for:

- Chrome executable path;
- dedicated profile directory;
- Chrome startup timeout;
- Chrome graceful-stop timeout;
- Keychain service/account;
- Keychain shim path.

The delivery postal code remains a runtime environment variable and must not be
stored in Git, Keychain token metadata, logs, or documentation.

## Error Handling

- Missing Chrome, profile, extension token, shim, or MCP binary: fail before
  Codex.
- Existing process using the profile: fail without attaching or terminating it.
- Chrome startup failure: stop any owned process and retain or release the lock
  based on confirmed shutdown.
- Extension missing or connection rejected: stop MCP, close owned Chrome, and
  return a failed run with token-free diagnostics.
- Amazon signed out or MFA required: make no cart changes, close Chrome, and
  request manual recovery.
- Report, schema, hash, or safety mismatch: preserve artifacts, close Chrome,
  and return nonzero.
- `Ctrl-C`, timeout, or signal: abort Codex, reap its MCP descendants, close
  owned Chrome, then release the lock.
- Chrome cannot be stopped: retain the lock and require the operator to confirm
  no profile process remains before manual removal.

## Testing Strategy

All automated tests remain offline.

Unit tests:

- Keychain setup command uses prompt mode and never includes a token argument.
- Shim retrieves a fake token without writing it to stdout/stderr or child
  arguments.
- Shim uses extension mode, absolute output directory, pinned MCP binary, and
  no user-data-dir/CDP/storage-state flags.
- Config validates executable paths, timeouts, and Keychain identifiers.
- Chrome manager rejects pre-existing profile processes.
- Chrome manager records ownership, waits for readiness, closes gracefully,
  escalates after timeout, and never kills an unowned process.
- Codex invocation preserves read-only and approval constraints.
- Authentication prompt contains no cart-mutating instructions.

Integration tests with fake executables:

- Success cleanup order is MCP stop, Chrome stop, lock release.
- Codex throw, nonzero, timeout, malformed report, signal, and chmod failure all
  close owned Chrome and handle the lock correctly.
- Browser-stop failure retains the lock.
- Auth-check false gates return failure without cart behavior.

No unit or CI test may launch Chrome, access Keychain, contact Amazon, or invoke
the real extension.

## Manual Acceptance Gates

Each gate must pass before continuing:

1. Install the official Playwright Extension in the dedicated profile and store
   its token in Keychain.
2. Launch on demand and attach to a harmless public page. Verify connection,
   evidence routing, MCP disconnect, Chrome shutdown, and lock cleanup.
3. Run `auth-check`. Verify the same live Chrome session is authenticated, at
   the expected location, and on Whole Foods, with no cart inspection or
   mutation.
4. Reconfirm the funded-account external-action boundary.
5. Run one supervised three-item cart smoke test.
6. Only after that succeeds, reconsider the three 10-item fixtures and
   controlled idempotency run.

## Success Criteria

- On-demand normal Chrome launch retains the Amazon login.
- Playwright MCP attaches without per-run manual approval after Keychain setup.
- The auth-only command completes without cart or account mutation.
- Every path stops MCP/browser control and closes only the owned Chrome
  instance.
- The dedicated profile is not left active and its lock is not released while
  still in use.
- No token, cookie, postal code, or account data appears in Git or normal logs.
- Existing cart safety and report-validation contracts remain intact.

## Known Limitations

- The Playwright Extension still grants generic control over attached tabs.
- The extension token and Keychain shim are containment, not a hard same-user
  security boundary.
- Amazon may still require MFA or invalidate sessions.
- Extension connection may briefly focus or activate Chrome on macOS.
- Browser automation may trigger Amazon anti-bot or fraud controls.
- Checkout prevention remains prompt-only until generic MCP is replaced by
  restricted cart-only tools.
