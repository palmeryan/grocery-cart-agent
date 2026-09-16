# Manual test runbook

Manual verification for the direct-CDP Whole Foods cart harness.
Historical dedicated-profile smoke notes remain in `docs/poc-runbook.md`.

All harness commands run from the repository root. `runs/` and the dedicated
browser profile are local runtime state; they are gitignored. Do not publish
live browser-session tokens. Automated verification must not mutate a cart.
Never use the everyday Chrome profile for the cart runner.

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
- Confirm authentication comes from `/api/account/summary` field
  `customer.authenticated`, not presentation text in the page header or body.
- Confirm `authenticated`, `deliveryModeConfirmed`, and
  `wholeFoodsStorefrontConfirmed` are true. Readiness does not inspect or
  require visible address text.
- Confirm `checkoutVisited` and `settingsChanged` are false.
- If authentication or delivery context is not ready, confirm the CLI prints the
  reason and leaves the dedicated Chrome window open. Sign in or correct the
  context there, close Chrome normally, and rerun `npm run auth-check`.
- Treat authentication and delivery context as readiness checks. The safety
  checks are the checkout and account/settings boundaries.

### Supervised Cart Agent smoke

- Put a small valid Shopping List at the gitignored path
  `runs/three-item-smoke.json`.
- Run one foreground build from the repository root while observing the
  dedicated Chrome window:

```bash
npm run cart-list -- runs/three-item-smoke.json
```

- Stop immediately on checkout, payment, order, or account-setting pages. If
  the delivery context changes or cannot be established, stop the build and
  return a failed report.
- Confirm the run created one Cart Agent result per requested ingredient. The
  browser session should remain the same while each Cart Agent context is fresh.
- Confirm the final structured cart check records product IDs, names, and
  quantities and that the current cart delta matches. `runStatus` describes
  execution; `verificationStatus` independently reports `confirmed`,
  `inconclusive`, or `not_run`. An inconclusive final read is recorded under
  `verificationNotes` and leaves Chrome open, but does not turn completed cart
  mutations into an execution failure.

### Full recipe-to-cart smoke

- After the direct Shopping List smoke succeeds, run the same supervised flow
  from one or more small recipe documents:

```bash
npm run cart-recipes -- recipe-one.md recipe-two.md
```

- Confirm the run saves `shopping-list.json`,
  `recipe-compilation.json`, and `ingredients-agent/output.json` before the Cart
  Agent results.

### Larger fixtures

- Proceed only after the supervised per-ingredient smoke succeeds.
- To expand coverage, use these three 10-item fixtures and rerun one unchanged
  request to check duplicate prevention:
  - `examples/staples.json`
  - `examples/ambiguous.json`
  - `examples/substitutions.json`
