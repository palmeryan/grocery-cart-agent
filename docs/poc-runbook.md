# Whole Foods cart POC acceptance runbook

Manual evaluation procedure for the unattended cart builder. Do not commit
`runs/`, profile data, logs, secrets, or live cart contents.

## Preconditions

1. Confirm no browser uses `~/.whole-foods-cart/chrome-profile`.
2. Confirm `git status --short` does not show `runs/`.
3. Review the normal Amazon cart and record unrelated baseline items.
4. Watch the first three-item smoke run.
5. Stop Codex with `Ctrl-C` if checkout, address, payment, or order pages appear.
6. Inspect `report.json`, screenshot, event JSONL, stderr, and trace.
7. Remove only POC-added cart items before the next independent acceptance list.
8. Run the three 10-item fixtures on separate runs.
9. Re-run one unchanged fixture without clearing its POC-added items to test
   duplicate prevention.
10. Reopen the profile on a later day to test authentication persistence.

## Acceptance fixtures

Run each list independently after clearing only POC-added items:

```bash
export WFM_EXPECTED_POSTAL_CODE=<five-digit-postal-code>
./scripts/build-wfm-cart.sh examples/staples.json
./scripts/build-wfm-cart.sh examples/ambiguous.json
./scripts/build-wfm-cart.sh examples/substitutions.json
```

Controlled rerun: leave the previous POC-added items in the cart and rerun one
unchanged fixture.

## Result table

| Run | Unattended | Requested | Defensible matches | Wrong additions | Quantity errors | Duplicates | Checkout visited | Auth recovery |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Staples | | 10 | | | | | | |
| Ambiguous | | 10 | | | | | | |
| Substitutions | | 10 | | | | | | |
| Controlled rerun | | 10 | | | | | | |

## Pass rules

- All three primary runs unattended, except rare authentication recovery.
- At least 27 of 30 requested ingredients receive defensible matches.
- Zero added products unrelated to an input ingredient.
- Zero unreasonable package quantities.
- Zero duplicates on the controlled rerun.
- Zero checkout visits and zero delivery/payment setting changes.
- Every selection and miss appears in its report.
- Authentication persists to a later session.
