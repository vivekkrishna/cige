# CIGE on Playwright Test

`e2e-cige/playwright` runs CIGE cases on [Playwright Test](https://playwright.dev/docs/intro),
the runner you already have. Each case's Execution is compiled once into
plain Playwright code, CI runs only that code with no model calls, and
every failure gets a run summary that says what kind it is. Playwright's
healer agent can already fix a failing test; the summary tells it whether
the fix is allowed.

```bash
npm i -D e2e-cige @playwright/test
```

Tested with `@playwright/test` 1.65.0 (peer range `>=1.56.0 <2`; 1.56 brought the
planner, generator, and healer agents).

## What lives where

The case is split so that the part a repair edits can't change what the
test proves:

| Part | Lives in | A repair may edit it | Guarded by |
| --- | --- | --- | --- |
| Execution: the `act` and `verify` steps | `<name>.cige.spec.ts`, one binding per step | Yes, when the failure is `outdated-test-logic` | Nothing: Execution is the part that drifts |
| Intent, Guardrails, evidence | `<name>.cige.json` | No | `cige diff` |
| Evidence hooks, the judge, plugins | `cige.config.ts` and what it imports | No | `cige diff` (`config-changed`) |

So put what a pass means in evidence hooks, not in `verify` bindings. A
`verify` step is Execution: it checks the path went where it should, and
a repair may rewrite it.

## Set it up

```ts
// cige.config.ts
import { defineCige } from 'e2e-cige/core';
import { playwrightRunner, type CigePlaywrightFixtures } from 'e2e-cige/playwright';

export default defineCige<CigePlaywrightFixtures>({
  root: new URL('.', import.meta.url),
  hooks: {
    orderExists: async ({ request }) => (await request.get('/api/orders/last')).ok(),
  },
  runners: { playwright: playwrightRunner() },
  runner: 'playwright',
});
```

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import cige from './cige.config.ts';

export default defineConfig({
  testMatch: '**/*.cige.spec.ts',
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  reporter: [['list'], ['e2e-cige/playwright/reporter', cige]],
});
```

The reporter writes `.e2e/cige/<id>.run-summary.json` for each case (set
`outputDir` in the CIGE config to move them). With no options it loads
`cige.config.ts` beside the Playwright config.

`playwrightRunner()` takes:

| Option | Does |
| --- | --- |
| `config` | The Playwright config, when it isn't the nearest `playwright.config.ts`; `cige run` and replay commands pass it |
| `judge` | A model judge for an Intent judged on the screen and for evidence `assert` items (below) |
| `sessions` | A storageState file per `Context.session` name, relative to the config's `root` |
| `specs` | Globs of the spec files that bind the cases; default every `*.cige.spec.ts` |
| `baseURL` | The site under test when the case's environment names none; else Playwright's `use.baseURL` |

## Compile a case

```bash
npx cige compile checkout     # or no id: every case no spec binds yet
```

This writes `checkout.cige.spec.ts` beside `checkout.cige.json`, with one stub per
`act` and `verify` step. Each stub has the step's goal, its values, and every
guardrail, with the enforced ones marked, written beside it:

```ts
import { expect } from '@playwright/test';
import { CigeError, cigeTest } from 'e2e-cige/playwright';

import config from '../cige.config.ts';

cigeTest(config, 'checkout', {
  // Step: Add the Field Guide to the cart
  e1: async ({ page }) => {
    throw new CigeError('STEP_NOT_COMPILED', 'e1 is not compiled yet: write its Playwright code');
  },
  // Verify: The total shows $45.00
  e2: async ({ page }) => {
    throw new CigeError('STEP_NOT_COMPILED', 'e2 is not compiled yet: write its Playwright code');
  },
});
```

Fill the stubs yourself, or have an agent do it: Playwright's generator,
or the `cige` skill, which reads the stubs and the live app. `compile`
makes no model call. Run it again on a spec that exists and it prints the
stubs the spec lacks, then exits 1; `--force` rewrites the file.

A binding gets the test's `page`, `context`, `request`, `browser`,
`testInfo`, and `baseURL`, plus `testCase`, `step`, and `params`: the
variant's values, then the step's own params. A case with variants is one
test per variant.

`cigeTest` checks the case when the spec loads, so these fail collection
before any test runs: a step with no binding, a binding with no step, a
hook the config doesn't define, and a case judged on the screen with no
`judge`.

## How a case runs

1. Each precondition hook.
2. `page.goto(Context.open)`, when set.
3. Each Execution entry, in its own `test.step` titled `CIGE <id> · <text>`:
   an `act` or `verify` runs its binding; a `use` runs its plugin's step.
4. Each piece of evidence: a hook holds only when it returns `true`; an
   `assert` item goes to the `judge`.
5. The Intent, through the `judge`, unless the case sets `"judge": false`.

Playwright has no agent, so a case meant to run here usually proves its
Intent with hook evidence and sets `"judge": false`. To keep a judged
Intent, give the runner a `judge`. It is your code in `cige.config.ts`, so
`cige diff` guards it:

```ts
playwrightRunner({
  judge: async ({ claim, context, page }) => {
    const verdict = await askModel({ claim, context, screenshot: await page.screenshot() });
    return { status: verdict.holds ? 'passed' : 'failed', summary: verdict.reason };
  },
});
```

The judge returns `passed`, `failed`, or `inconclusive`. A throw is
`inconclusive`, or `provider.error` when it reads like a key or a quota.

## What a failure means

The adapter reads Playwright's own error, where it was thrown:

| Playwright says | In a step | `failureType` |
| --- | --- | --- |
| An action's locator never resolved (`waiting for getByRole(...)`) | `act` or `verify` | `outdated-test-logic` |
| `strict mode violation` | `act` or `verify` | `outdated-test-logic` |
| The locator resolved, but the element never became actionable (hidden, disabled, covered) | `act` | `outdated-test-logic` |
| An `expect` that found no element (`element(s) not found`) | `act` or `verify` | `outdated-test-logic` |
| An `expect` that found the element with the wrong value | `verify` | `product-defect` |
| An `expect` that found the element with the wrong value | `act` | Absent, `goal-unreachable` |
| An evidence hook returned something other than `true`, or its `expect` failed | evidence | `product-defect` |
| The judge said `failed` | the Intent, an `assert` | `product-defect` |
| `net::ERR_*`, a navigation timeout, a precondition that threw | any | `infrastructure` |
| A request an `x-deny-requests` rule blocked | any | Absent, `guardrail-violation:<id>` |
| Any other timeout | `act` | Absent, `automation-limit` |
| The test's own timeout | any | Absent, `run-stopped` |
| A stub not written yet | any | Absent, code `STEP_NOT_COMPILED` |

The routing is the same `classify` every runner uses, and the conformance
kit proves it (`tests/playwright.conformance.test.ts`).

A failed test also carries what it means in Playwright's own result. A
`cige-outcome` attachment holds the failure, and one line is appended to
the error, after Playwright's message:

```
CIGE checkout failed at step e3: product-defect. The app contradicts the Intent: do not change this test,
its expected values, or mark it fixme; report the defect. Summary: .e2e/cige/checkout.run-summary.json
```

A healer that reads only the failure output still gets the rule.

## Guardrails

| Rule | On Playwright |
| --- | --- |
| `x-deny-requests: ["POST **/payments*"]` | Enforced: `context.route()` aborts the request, and the step that sent it fails as that guardrail's violation, even if the app swallowed the error |
| Guardrail prose | Written beside the bindings by `compile`; no agent reads it at run time |
| `deny.actions`, `deny.summary`, plugin `onAction` | Advisory: Playwright reports no per-action events |

`x-deny-requests` covers the page and its context. It does not cover the
`request` fixture a hook uses: that is your code.

## Heal with Playwright's agents

```bash
npx playwright init-agents --loop=claude    # or vscode, opencode
npx cige healer                             # add the CIGE rule to the healer it wrote
```

The healer fixes failing tests, "assertions and expected values" included,
and marks one it can't fix `test.fixme()`. On a product defect, both hide
the bug. `cige healer` adds a block between `<!-- cige:begin -->` and
`<!-- cige:end -->` markers to the healer's agent file. It tells the
healer to:

1. Read the summary first.
2. Repair a binding only on `outdated-test-logic`.
3. Stop and report a `product-defect`, never weakening an `expect`,
   marking the test fixme, or editing the app's code to fix it.
4. Report an `infrastructure` failure or a guardrail violation without
   changing anything.
5. Never edit a `.cige.json` file or `cige.config.ts`.
6. Rerun the case's tests after a repair, and `npx cige diff` when it
   has a shell. The generated healer has none.

Run it again after `init-agents`: it replaces its block rather than
adding a second. `--print` shows it.

## Commands

```bash
npx cige run                          # playwright test --grep @cige
npx cige run checkout                 # one case: --grep @cige:checkout
npx cige replay checkout              # reset its environment, run it alone with --retries 0
npx cige check                        # a case no spec binds, a judged case with no judge, a session with no file
npx cige run --runner auto --dry-run  # which runner each case would run on, and why
```

Pass Playwright's own options after `--`: `npx cige run -- --project chromium --headed`.
A case run in several Playwright projects gets one summary per project,
named after it.

With no environments declared, a summary's replay command is Playwright's
own: `npx playwright test --grep '@cige:checkout(?![\w:./-])' --retries 0`.

## What Playwright Test can't do here

- No agent acts, so a step only goes as far as its binding: a changed flow
  fails as `outdated-test-logic` until the binding is repaired, where e2e
  or Vibium might have found a new path on its own.
- No refusal and no missing-information signals: no agent stops itself.
- No `rejudge`: there is no stored recording a judge reads offline.
- `Context.agent` and `Context.requires` are ignored (`cige check` says
  so); use Playwright projects instead.
- Custom fixtures from `test.extend()` reach no binding or hook: they get
  the built-in fixtures listed above.

`examples/playwright` is a working project: a small shop, three cases
(one with variants, one with an enforced payments guardrail), and their
compiled specs, with switches that break the shop in each of the three
ways above.
