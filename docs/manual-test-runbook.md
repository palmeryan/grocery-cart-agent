# Manual test runbook

Manual verification for the direct-CDP Whole Foods cart harness.
Historical dedicated-profile smoke notes remain in `docs/poc-runbook.md`.

All harness commands run from the repository root. Do not commit `runs/`,
profile data, logs, secrets, tokens, cookies, storage state, or live cart
contents. Automated verification must not mutate a cart. Never use the everyday
Chrome profile for the cart runner.

Before a run:

1. Confirm no browser uses the dedicated Chrome profile.
2. Confirm `git status --short` does not show `runs/`.
3. Watch the first end-to-end run. Stop with `Ctrl-C` on checkout, payment, order, or
   account-setting pages.

## Browser verification

Run commands from the repository root. The cart build and model-free checks use
the same owned Chrome profile and localhost CDP endpoint.

### One-time profile setup

- Open only the dedicated profile with `npm run login`.
- Sign in to Whole Foods Market manually.
- Close the dedicated browser.

### Attachment diagnostic

- Confirm the dedicated profile is closed.
- Run `npm run cart -- attachment-check`.
- Confirm the report contains `connected: true`, `url: "https://example.com/"`,
  and `title: "Example Domain"`; `interactionPerformed` remains false.
- Confirm the command closes the dedicated Chrome window and, from the
  repository root,
  `ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'`
  finds no Chrome process.
- Confirm `.wfm-cart.lock` is absent at the repository root.
- Do not browse the storefront in this gate.

### Delivery-context check

- Run `npm run auth-check`.
- Confirm `authenticated`, `deliveryModeConfirmed`,
  `deliveryAddressConfirmed`, and `wholeFoodsStorefrontConfirmed` are true.
  The deterministic delivery check accepts the saved context when `43214`
  appears anywhere in the page text. It does not open the location picker or
  start a separate postal-code workflow.
- Confirm `checkoutVisited` and `settingsChanged` are false.

### Supervised per-ingredient smoke

- Put a small valid grocery request at the gitignored path
  `runs/three-item-smoke.json`.
- Run one foreground build from the repository root while observing the
  dedicated Chrome window:

```bash
npm run cart -- build runs/three-item-smoke.json
```

- Stop immediately on checkout, payment, order, or account-setting pages. If
  the delivery context changes or cannot be established, stop the build and
  return a failed report.
- Confirm the run created one ingredient-agent result per requested ingredient.
  The browser session should remain the same while the agent contexts change.
- Confirm the final deterministic cart-text check records the expected
  product-name/quantity evidence and that the current cart delta matches. Any
  mismatch is reported under `verificationNotes`; it does not trigger a retry
  or rewrite the agent's selection.

### Larger fixtures

- Proceed only after the supervised per-ingredient smoke succeeds.
- To expand coverage, use these three 10-item fixtures and rerun one unchanged
  request to check duplicate prevention:
  - `examples/staples.json`
  - `examples/ambiguous.json`
  - `examples/substitutions.json`
