# Whole Foods Cart Builder

Local cart runner using Codex CLI and Playwright MCP. The **Ingredients Agent** reads recipe documents and produces the versioned `ShoppingPlan`; the **Cart Agent** receives one ingredient at a time and uses a fresh invocation to add products to Whole Foods. The ShoppingPlan contract remains versioned and unchanged.

The shell owns the dedicated Chrome lifecycle, preflight, baseline cart inspection, one fresh Cart Agent invocation per ingredient, and final verification. Baseline/final extraction degradation and any verification mismatch fail the run; they are never reported as successful. The browser returns to the Whole Foods grocery search page after baseline inspection before the first Cart Agent starts.

## Configuration

Safe Ryan/Lamar defaults are retained, but delivery context is configurable:

- `WFM_EXPECTED_DELIVERY_ADDRESS` — expected visible address text (optional when ZIP is sufficient).
- `WFM_EXPECTED_DELIVERY_ZIP` — expected ZIP; defaults to `43214`.
- `WFM_CHROME_PROFILE_DIR`, `WFM_MAX_RUN_MS`, `WFM_CHROME_STARTUP_TIMEOUT_MS`, and `WFM_CHROME_STOP_TIMEOUT_MS` retain their existing meanings.

Address confirmation and delivery-mode confirmation are independent observations. Checkout and account/settings safety remains enforced.

## Install and run

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run login
npm run cart -- attachment-check
npm run auth-check
npm run cart -- build path/to/request.json
```

Use `docs/manual-test-runbook.md` for live verification. Keep the dedicated profile and `runs/` output private; do not checkout or submit an order.
