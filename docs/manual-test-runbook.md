# Manual test runbook

Staged operator gates for the attached-browser Whole Foods cart harness.
Historical dedicated-profile smoke notes remain in `docs/poc-runbook.md`.

Do not commit `runs/`, profile data, logs, secrets, tokens, cookies, or live
cart contents. Automated verification must not open Amazon or mutate a cart.

Preconditions shared with the POC runbook still apply:

1. Confirm no browser uses the dedicated POC Chrome profile.
2. Confirm `git status --short` does not show `runs/`.
3. Watch every live gate. Stop with `Ctrl-C` on checkout, address, payment, or
   order pages.
4. Never export cookies or Playwright storage state.
5. Never use the everyday Chrome profile for this POC.

Use only the non-routable postal test value when documenting environment setup:

```bash
export WFM_EXPECTED_POSTAL_CODE=00000
```

## Attached-browser acceptance

Run gates in order and stop on the first failure.

### Gate 1: extension and Keychain setup

- Open only the dedicated profile with `npm run login`.
- Install the official Playwright MCP Browser Extension in that profile.
- Sign in to Amazon manually.
- Run `npm run setup-extension-token`.
- Confirm `security find-generic-password -a "$USER" -s "whole-foods-cart.playwright-extension"` succeeds without `-w`.
- Close the dedicated browser.

### Gate 2: harmless public-page attachment

- Confirm the dedicated profile is closed.
- Run `npm run cart -- attachment-check`.
- Confirm the report contains only `connected: true`,
  `url: "https://example.com/"`, `title: "Example Domain"`,
  `navigationPerformed: false`, and `interactionPerformed: false`.
- Confirm the command closes the dedicated Chrome window and
  `ps -axo pid=,command= | grep -- '--user-data-dir=.*/.whole-foods-cart/chrome-profile'`
  finds no Chrome process.
- Confirm `.wfm-cart.lock` is absent.
- Do not browse Amazon in this gate.

### Gate 3: non-mutating Amazon auth check

- Obtain explicit operator approval to use the live authenticated account.
- Run `npm run auth-check`.
- Confirm `authenticated`, `expectedLocationConfirmed`, and
  `wholeFoodsStorefrontConfirmed` are true.
- Confirm `checkoutVisited` and `settingsChanged` are false.
- Confirm no cart contents were read or changed.

### Gate 4: external-action reconfirmation

- Explain that generic browser control is acting on a funded Amazon account.
- Reconfirm that the next gate may add products to the Whole Foods cart.
- Do not proceed without explicit approval.

### Gate 5: supervised three-item smoke

- Use the approved three-item fixture only.
- Run one foreground build while observing the dedicated Chrome window.
- Stop immediately on checkout, settings, location, or storefront uncertainty.
- Confirm the report and current cart delta match exactly.

### Gate 6: larger fixtures

- Proceed only after Gate 5 succeeds.
- Reconsider, rather than automatically run, three 10-item fixtures and one
  controlled idempotency run.
