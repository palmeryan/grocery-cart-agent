# Whole Foods cart POC acceptance runbook

Manual evaluation procedure for the unattended cart builder. Do not commit
`runs/`, profile data, logs, secrets, or live cart contents.

## Preconditions

1. Confirm no browser uses the dedicated POC Chrome profile.
2. Confirm `git status --short` does not show `runs/`.
3. Review the current Whole Foods cart and identify unrelated baseline items.
4. Confirm the saved default address is in delivery mode with Lamar as the
   store context.
5. Watch the first three-item smoke run. Stop Codex with `Ctrl-C` if checkout,
   payment, account settings, or order pages appear.
6. Inspect `report.json` and the event output for the cart delta.
7. Remove only POC-added cart items before the next independent acceptance list.
8. Run the three 10-item fixtures on separate runs.
9. Re-run one unchanged fixture without clearing its POC-added items to test
   duplicate prevention.
10. Reopen the profile on a later day to test authentication persistence.

## Acceptance fixtures

Run each list independently after clearing only POC-added items:

```bash
./scripts/build-wfm-cart.sh examples/staples.json
./scripts/build-wfm-cart.sh examples/ambiguous.json
./scripts/build-wfm-cart.sh examples/substitutions.json
```

Controlled rerun: leave the previous POC-added items in the cart and rerun one
unchanged fixture.

## Smoke results (Task 8)

**POC outcome: failed / inconclusive for cart matching.** Authentication blocked
the first gate, so product selection quality was never measured.

| Attempt | Gate reached | Auth | Products added | Checkout | Settings changed | Notes |
|---|---|---|---:|---|---|---|
| Initial smoke | Blocked before navigation | N/A | 0 | No | No | MCP tool approval rejected under `default_tools_approval_mode="auto"` with `approval_policy="never"`. Fixed in `122b465` (`"approve"`, read-only sandbox kept, absolute final screenshot path). |
| Disposable public-page probe | Navigation + screenshot OK | N/A | 0 | No | No | Confirmed MCP navigate and absolute screenshot placement after the fix. |
| Supervised smoke #1 | Whole Foods storefront + expected location | Unauthenticated | 0 | No | No | Session not signed in. |
| Manual auth recovery | N/A (manual) | Signed-in header verified | 0 | No | No | User signed in on the dedicated profile and quit Chrome cleanly. Single allowed recovery. |
| Supervised smoke #2 | Whole Foods storefront + expected location | Unauthenticated | 0 | No | No | Auth still did not persist into Playwright MCP after recovery. |

Safety observed across all attempts:

- No products added.
- Checkout never visited.
- Delivery/payment settings not changed.
- No unrelated cart items changed.

Because the three-item smoke gate failed after the single allowed manual auth
recovery, the three 10-item fixtures, controlled idempotency rerun, and later-day
persistence check were **not run**.

## Result table

| Run | Unattended | Requested | Defensible matches | Wrong additions | Quantity errors | Duplicates | Checkout visited | Auth recovery |
|---|---|---:|---|---|---|---|---|---|
| Smoke (3-item) | Failed at auth gate | 3 | Not run | 0 | N/A | N/A | No | Attempted once; auth did not persist into MCP |
| Staples | Not run | 10 | Not run | N/A | N/A | N/A | N/A | N/A |
| Ambiguous | Not run | 10 | Not run | N/A | N/A | N/A | N/A | N/A |
| Substitutions | Not run | 10 | Not run | N/A | N/A | N/A | N/A | N/A |
| Controlled rerun | Not run | 10 | Not run | N/A | N/A | N/A | N/A | N/A |
| Later-day persistence | Not run | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

## Historical architecture decision (Task 8)

**Authentication dominates: use an attached normal browser session.**

A dedicated Chromium user-data-dir profile plus Playwright MCP did not retain a
usable Amazon session across a clean manual sign-in and subsequent MCP launch.
That result motivated the attached-browser work documented in the current
README and manual runbook. It is historical evidence, not a current run
requirement.

## Pass rules

- All three primary runs complete with the saved delivery address and Lamar
  context.
- At least 27 of 30 requested ingredients receive defensible matches.
- Zero added products unrelated to an input ingredient.
- Zero unreasonable package quantities.
- Zero duplicates on the controlled rerun.
- Zero checkout visits and zero delivery/payment setting changes.
- Every selection and miss appears in its report.
- Authentication persists to a later session.
