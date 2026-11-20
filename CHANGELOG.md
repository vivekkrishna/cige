# Changelog

## 0.3.0

Run CIGE cases on Playwright Test, the runner most teams already have.

- `e2e-cige/playwright`: `cigeTest(config, id, bindings)` in a
  `*.cige.spec.ts` file registers a case as Playwright tests, each `act`
  and `verify` step bound to Playwright code. CI runs that code with no
  model calls. `playwrightRunner({ judge, sessions, config, specs, baseURL })`
  names it in the CIGE config.
- `e2e-cige/playwright/reporter` writes the same run summaries as e2e and
  Vibium. It reads failure types from Playwright's own errors: a locator
  that no longer resolves is `outdated-test-logic`, and an `expect` in a
  `verify` that finds the wrong value is `product-defect`. The conformance
  kit passes on real Chromium.
- A failed test's error ends with one line: its failure type, and what a
  repair may touch. Playwright's healer reads the rule without any setup.
- A guardrail's `x-deny-requests` is enforced with `context.route()`.
- `cige compile [<id>]` writes a case's spec, a binding stub per step, with
  the goal and guardrails beside each. It makes no model call.
- `cige healer` adds the CIGE rule to the healer agent `npx playwright
  init-agents` writes. The healer must read the summary first, repair only
  `outdated-test-logic`, and on a product defect report it, touching
  neither the test nor the app.
- `cige run`, `replay`, `check`, and `auto` know the `playwright` runner.
  `check` and `auto` skip it for a case no spec binds, and for one judged
  on the screen when it has no judge.
- Runner contract: `readiness(testCase, { root })` and `launch(request)`
  for hosted adapters other than e2e, and an `agents` capability.
  `denyRequests` and the hosted-run env helpers moved to `e2e-cige/core`;
  `e2e-cige/vibium` and `e2e-cige/e2e` still export what they did.
- `@playwright/test` is a new optional peer, `>=1.56.0 <2`, tested on
  1.65.0.

## 0.2.1

The npm description and keywords lead with the CIGE standard and name
Vibium; no code changes since 0.2.0.
