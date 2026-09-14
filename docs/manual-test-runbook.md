# Manual test runbook

Staged operator gates for the attached-browser Whole Foods cart harness.
Historical dedicated-profile smoke notes remain in `docs/poc-runbook.md`.

All harness commands run from the repository root. Do not commit `runs/`,
profile data, logs, secrets, tokens, cookies, storage state, or live cart
contents. Automated verification must not open Amazon or mutate a cart. Never
use the everyday Chrome profile for this POC.

Preconditions shared with the POC runbook still apply:

1. Confirm no browser uses the dedicated POC Chrome profile.
2. Confirm `git status --short` does not show `runs/`.
3. Watch every live gate. Stop with `Ctrl-C` on checkout, address, payment, or
   order pages.

Before any attachment-check, auth-check, or build command, set the
documentation/offline postal value in the local shell. `00000` is
documentation and offline only; it is not a live delivery location.

```bash
export WFM_EXPECTED_POSTAL_CODE=00000
```

## Attached-browser acceptance

Run gates in order from the repository root and stop on the first failure.

### Gate 1: extension and Keychain setup

- Open only the dedicated profile with `npm run login`.
- Install the official Playwright MCP Browser Extension in that profile.
- Sign in to Amazon manually.
- Run `npm run setup-extension-token`.
- Confirm `security find-generic-password -a "$USER" -s "whole-foods-cart.playwright-extension"` succeeds without `-w`.
- Close the dedicated browser.

### Gate 2: harmless public-page attachment

- Confirm the dedicated profile is closed.
- Confirm `WFM_EXPECTED_POSTAL_CODE=00000` is set for this offline gate.
- Run `npm run cart -- attachment-check`.
- Confirm the report contains only `connected: true`,
  `url: "https://example.com/"`, `title: "Example Domain"`,
  `navigationPerformed: false`, and `interactionPerformed: false`.
- Confirm the command closes the dedicated Chrome window and, from the
  repository root,
  `ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'`
  finds no Chrome process.
- Confirm `.wfm-cart.lock` is absent at the repository root.
- Do not browse Amazon in this gate.

### Gate 3: non-mutating Amazon auth check

- Obtain explicit operator approval to use the live authenticated account.
- In the local shell only, set `WFM_EXPECTED_POSTAL_CODE` to the real expected
  delivery postal code. Do not write that value to Git, Keychain, logs, or
  docs, and do not record a real postal code in this runbook.
- Run `npm run auth-check`.
- Confirm `authenticated`, `expectedLocationConfirmed`, and
  `wholeFoodsStorefrontConfirmed` are true.
- Confirm `checkoutVisited` and `settingsChanged` are false.
- Confirm no cart contents were read or changed.

### Gate 4: external-action reconfirmation

- Explain that generic browser control is acting on a funded Amazon account.
- Reconfirm that the next gate may add products to the Whole Foods cart.
- Confirm the real expected postal code remains set in the local shell only
  (never committed, logged, Keychain-stored, or documented).
- Do not proceed without explicit approval.

### Gate 5: supervised three-item smoke

- Keep the real expected postal code in the local shell only.
- Create or copy a separately reviewed, exactly three-item valid grocery
  request to the gitignored path `runs/approved-three-item-smoke.json`. Do not
  invent an unreviewed recipe in the repository and do not commit that file.
- Run one foreground build from the repository root while observing the
  dedicated Chrome window:

```bash
npm run cart -- build runs/approved-three-item-smoke.json
```

- Stop immediately on checkout, settings, location, or storefront uncertainty.
- Confirm the report and current cart delta match exactly.

### Gate 6: larger fixtures

- Proceed only after Gate 5 succeeds.
- Reconsider, rather than automatically run, these three 10-item fixtures and
  one controlled idempotency run:
  - `examples/staples.json`
  - `examples/ambiguous.json`
  - `examples/substitutions.json`
