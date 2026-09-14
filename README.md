# Whole Foods Cart Builder POC

Local feasibility harness using ChatGPT-authenticated Codex CLI and Microsoft
Playwright MCP. This repository records earlier **negative / incomplete**
dedicated-profile results and now documents the attached-browser authentication
path for further offline and supervised experiments. It is not a proven cart
builder.

## Current outcome

The earlier dedicated-profile live smoke **failed** because Amazon
authentication did not persist into Playwright MCP after a clean manual
sign-in. Cart-matching acceptance runs (staples / ambiguous / substitutions,
controlled rerun, later-day persistence) were **not performed**.

This branch documents and implements attachment through a CLI-owned dedicated
Chrome profile plus the official Playwright MCP Browser Extension. Operators
must complete the staged gates in `docs/manual-test-runbook.md` before any live
Amazon or cart action. Treat the commands below as the harness entrypoint, not
as a verified end-to-end cart builder.

## Safety warning

This POC gives Codex generic control of a browser that may be signed into a
funded Amazon account. Checkout prevention is prompt-only, not a hard security
boundary. Watch any live run. Stop the process immediately (`Ctrl-C`) if it
enters checkout or changes account settings.

Never export cookies or Playwright storage state. Never use the everyday Chrome
profile for this POC. Sensitive output under `runs/` must never be committed or
uploaded.

## Prerequisites

- macOS with Google Chrome
- Node.js 22.16.0 or newer
- Codex CLI 0.154.0 or newer, signed into the intended ChatGPT account

All harness commands below run from the repository root.

## Install

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## Attached browser authentication

The cart command launches and owns a dedicated normal Chrome instance at
`~/.whole-foods-cart/chrome-profile`. It never attaches to the everyday Chrome
profile.

Set the documentation/offline postal value in the local shell before any
attachment-check, auth-check, or build command. `00000` is documentation and
offline only; it is not a live delivery location.

```bash
export WFM_EXPECTED_POSTAL_CODE=00000
```

1. Run `npm run login`.
2. In that dedicated Chrome profile, install Microsoft's official Playwright
   MCP Browser Extension.
3. Sign in to Amazon and select the intended Whole Foods delivery location.
4. Copy the extension token, then run `npm run setup-extension-token`. Paste
   the token only into the hidden macOS Keychain prompt.
5. Close the dedicated Chrome window.
6. Run `npm run cart -- attachment-check` to verify the extension against
   Example Domain without opening Amazon.
7. Before `auth-check` or any cart build, set the real expected postal code in
   the local shell only. Do not write that value to Git, Keychain, logs, or
   docs, and do not paste a real postal code into committed files.
8. Run `npm run auth-check`.
9. After the auth check succeeds, run
   `npm run cart -- build path/to/request.json`.

The CLI starts Chrome on demand and closes only the instance it launched.
Codex receives neither the extension token nor the Keychain lookup command.

### Recovery lock

If the CLI says Chrome still uses the dedicated profile, it intentionally
leaves `.wfm-cart.lock` in place. Do not remove it while any process uses
`~/.whole-foods-cart/chrome-profile`.

From the repository root, inspect first:

```bash
ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'
```

After confirming that no matching Chrome process remains, remove the lock from
the repository root only:

```bash
rm .wfm-cart.lock
```

## Manual gates

Run the staged acceptance sequence in `docs/manual-test-runbook.md` in order
from the repository root. Attachment-check comes before auth-check. Obtain
explicit operator approval before any live Amazon read and before any cart
mutation. Do not remove a recovery lock until the repository-root inspect step
shows no Chrome process on the dedicated profile.
