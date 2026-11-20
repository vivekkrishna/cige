# CIGE on Playwright Test: an example

A small shop (`server.mjs`) with three CIGE cases, run as Playwright tests:

| Case | Shows |
| --- | --- |
| `tests/cart.cige.json` | A precondition hook, `Context.open`, a `verify` step, and hook evidence |
| `tests/checkout.cige.json` | An enforced guardrail: `x-deny-requests` blocks the live payments API |
| `tests/login.cige.json` | Variants: one test per shopper, with the values in `params` |

Each case's steps are bound to Playwright code in the `.cige.spec.ts` file
beside it. `npx cige compile` wrote the stubs, and the code fills them.
What a pass means lives in the `.cige.json` files and `cige.config.ts`,
where `cige diff` guards it.

```bash
# in the repository root, once
npm ci && npm run build
# here
npm install
npx playwright install chromium
npx playwright test        # or: npx cige run
npx cige check             # what each case still lacks
```

The summaries land in `.e2e/cige/<id>.run-summary.json`.

`e2e-cige` installs from the repository as a packed copy (`.npmrc` sets
`install-links`), so after rebuilding it, refresh the copy:
`rm -r node_modules/e2e-cige && npm install`.

## Break it three ways

Each switch breaks the shop the way real changes do, and each gets a
different verdict:

```bash
SHOP_RENAME=1 npx playwright test          # "Add to cart" now reads "Add to bag"
SHOP_BUG=discount npx playwright test      # the total ignores SAVE10
SHOP_LIVE_PAYMENTS=1 npx playwright test   # checkout calls the live payments API
```

| Switch | `failureType` | What a healer may do |
| --- | --- | --- |
| `SHOP_RENAME=1` | `outdated-test-logic` at `e1` | Repair the binding: the button's new name |
| `SHOP_BUG=discount` | `product-defect` at `e3` | Nothing to the test: report the defect |
| `SHOP_LIVE_PAYMENTS=1` | None; `guardrail-violation:no-live-payments` at `e4` | Nothing: the request was blocked, and the spec decides |

The failure output ends with the same verdict, for an agent that reads
only that. To give Playwright's healer the rule:

```bash
npx playwright init-agents --loop=claude
npx cige healer
```
