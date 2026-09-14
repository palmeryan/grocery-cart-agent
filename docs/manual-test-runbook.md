# Manual test runbook

Manual verification for the attached-browser Whole Foods cart harness.
Historical dedicated-profile smoke notes remain in `docs/poc-runbook.md`.

All harness commands run from the repository root. Do not commit `runs/`,
profile data, logs, secrets, tokens, cookies, storage state, or live cart
contents. Automated verification must not open Amazon or mutate a cart. Never
use the everyday Chrome profile for this POC.

Before a run:

1. Confirm no browser uses the dedicated POC Chrome profile.
2. Confirm `git status --short` does not show `runs/`.
3. Watch the first end-to-end run. Stop with `Ctrl-C` on checkout, payment, order, or
   account-setting pages.

## Attached-browser verification

Run commands from the repository root. Setup is needed once; the attachment
and delivery checks are diagnostics, not approval gates before every build.

### One-time extension and Keychain setup

- Open only the dedicated profile with `npm run login`.
- Install the official Playwright MCP Browser Extension in that profile.
- Sign in to Amazon manually.
- Run `npm run setup-extension-token`.
- Confirm `security find-generic-password -a "$USER" -s "whole-foods-cart.playwright-extension"` succeeds without `-w`.
- Close the dedicated browser.

### Attachment diagnostic

- Confirm the dedicated profile is closed.
- Run `npm run cart -- attachment-check`.
- Confirm the report contains `connected: true`, `url: "https://example.com/"`,
  and `title: "Example Domain"`; `navigationPerformed` may be true when the
  connection page was redirected, and `interactionPerformed` remains false.
- Confirm the command closes the dedicated Chrome window and, from the
  repository root,
  `ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'`
  finds no Chrome process.
- Confirm `.wfm-cart.lock` is absent at the repository root.
- Do not browse Amazon in this gate.

### Delivery-context check

- Run `npm run auth-check`.
- Confirm `authenticated`, `deliveryModeConfirmed`,
  `deliveryAddressConfirmed`, and `wholeFoodsStorefrontConfirmed` are true.
  The delivery check means the saved default address is usable; Lamar is the
  intended store, with no requirement for a particular header label;
  it is not a separate postal-code workflow.
- Confirm `checkoutVisited` and `settingsChanged` are false.

### Supervised three-item smoke

- Put an exactly three-item valid grocery request at the gitignored path
  `runs/three-item-smoke.json`.
- Run one foreground build from the repository root while observing the
  dedicated Chrome window:

```bash
npm run cart -- build runs/three-item-smoke.json
```

- Stop immediately on checkout, payment, order, or account-setting pages. If
  the delivery context changes or cannot be established, stop the build and
  return a failed report.
- Confirm the report and current cart delta match exactly.

### Larger fixtures

- Proceed only after the supervised three-item smoke succeeds.
- To expand coverage, use these three 10-item fixtures and rerun one unchanged
  request to check duplicate prevention:
  - `examples/staples.json`
  - `examples/ambiguous.json`
  - `examples/substitutions.json`
