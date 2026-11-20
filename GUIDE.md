# CIGE test cases

Write tests as Context, Intent, Guardrails, and Execution, and hand failures to agents that classify and repair them.

[CIGE](https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard)
is a test case standard for agentic testing. A case has four fields, and
each one changes for a different reason:

| Field | Says | Changes |
| --- | --- | --- |
| Context | Where the test runs: the system, the environment, the actor, the state it starts from | When the environment drifts, with a human's approval |
| Intent | Why the test exists and what a pass needs | Rarely, and only with a human's approval |
| Guardrails | What the agent must never do | Only to get stricter |
| Execution | The first path to try | Whenever the product's flow changes |

`e2e-cige` runs `.cige.json` cases as e2e tests, on Vibium, or as
Playwright tests, and writes one run summary per result. The `cige` agent skill reads it, classifies the failure,
and makes only the repair that kind of failure allows.

## When to use CIGE

Use CIGE cases when agents run and maintain your tests: the flows change
often, a coding agent fixes failures and must tell a stale path from a bug,
or a pass needs proof beyond the screen. Keep exact locator code and
TypeScript control flow in `*.e2e.ts` files. Both kinds run in one suite.

## Install

```bash
npm install -D e2e-cige e2e
```

To run the cases on Vibium instead, or as well, see
[Run the same cases on Vibium](#run-the-same-cases-on-vibium). On a
Playwright Test suite, see
[Run the same cases on Playwright Test](#run-the-same-cases-on-playwright-test).

## Write a case

```json title="tests/cige/checkout.cige.json"
{
  "$schema": "../../node_modules/e2e-cige/schema/cige-1.schema.json",
  "id": "checkout-discount",
  "Context": {
    "system": "Shop web app",
    "environment": "staging",
    "open": "/cart",
    "preconditions": [{ "hook": "seedCart", "description": "The cart holds two of ITEM-100" }],
    "specRef": "docs/specs/checkout.md",
    "buildRef": "releases/{build}.md"
  },
  "Intent": {
    "statement": "A shopper can check out with a valid discount code",
    "success": ["The total is 10% below the subtotal"],
    "evidence": [{ "id": "order-record", "hook": "orderPersisted" }]
  },
  "Guardrails": [
    "Use only the test card",
    { "id": "no-refund", "rule": "Never refund an order", "deny": { "actions": ["tool:refund"] } }
  ],
  "Execution": [
    { "id": "e1", "step": "apply the discount code {code}", "params": { "code": "SAVE10" } },
    { "id": "e2", "verify": "the total shows the discount" },
    { "id": "e3", "step": "pay with the test card" }
  ]
}
```

- `id` tags the test `cige:<id>` and names its run summary.
- The package ships `schema/cige-1.schema.json`, generated from the
  loader's own schema. An unknown key fails to load rather than being
  ignored, except keys that start with `x-` ([Extend CIGE](#extend-cige)).
- `specRef` and `buildRef` point to the spec and the build's release notes,
  the ground truth a classifier compares a failure with. The model never
  sees them. `{build}` is filled in for each run.

## Set up the config

Declare the cases, their hooks, and the environments they run in one time,
in `cige.config.ts`. The suite, the reporter, and the `cige` command
all read it. Set `root` so all three find the same files.

```ts title="cige.config.ts"
import { defineCige } from 'e2e-cige';

export default defineCige({
  cases: 'tests/cige/*.cige.json',
  root: new URL('.', import.meta.url),
  build: process.env.GITHUB_SHA,
  hooks: {
    // Precondition: seed the cart through the test API, not the UI.
    seedCart: async () => {
      const response = await fetch('http://localhost:3000/test-api/cart', { method: 'POST', body: '{"sku":"ITEM-100","qty":2}' });
      if (!response.ok) throw new Error(`seeding the cart returned ${response.status}`);
    },
    // Evidence: the order exists in the backend. Only `true` holds.
    orderPersisted: async ({ screen }) => {
      const orderId = await screen.getByTestId('order-id').textContent();
      if (orderId === null || orderId.trim() === '') return false;
      const response = await fetch(`http://localhost:3000/test-api/orders/${encodeURIComponent(orderId.trim())}`);
      return response.ok;
    },
  },
  environments: {
    staging: {
      config: 'e2e.config.ts',
      reset: async () => {
        const response = await fetch('http://localhost:3000/test-api/reset', { method: 'POST' });
        if (!response.ok) throw new Error(`resetting staging returned ${response.status}`);
      },
    },
  },
});
```

Register the cases from a test file, and add the reporter:

```ts title="tests/cige.e2e.ts"
import { cigeSuite } from 'e2e-cige';
import cigeConfig from '../cige.config.ts';

cigeSuite(cigeConfig);
```

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { cige } from 'e2e-cige';
import { gateway } from 'ai';
import cigeConfig from './cige.config.ts';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: { default: { model: gateway('openai/gpt-6-luna-fast') } },
  reporters: ['list', cige(cigeConfig)],
} satisfies E2EConfig;
```

Collection fails before any test runs on a case that doesn't validate, a
hook or environment the config lacks, or a glob that matches no file. Run
one case by its id, and check every case has what triage needs (refs, a
build, an environment that resets) before anything fails:

```bash
npx e2e run --tag cige:checkout-discount
npx cige check --resolve
```

## How a case runs

The test's title is the Intent statement. Its body runs these steps in
order and fails on the first one that doesn't hold:

1. Each precondition hook, then `app.open(Context.open)`.
2. Each Execution entry. A `step` is one [`agent.act`](https://e2e.tester.army/docs/reference/agent#agent-act)
   goal, with its `params`. A `verify` is one `agent.assert`.
3. Each piece of evidence: an `assert` is one `agent.assert`, and a `hook`
   holds only when it returns `true`.
4. `agent.assert` of the Intent statement and its criteria, unless
   `"judge": false`.

Context reaches the model as the test's
[`agentContext`](https://e2e.tester.army/docs/agents#instructions-and-vocabulary). The refs never do.

## Run a case on several dimensions

Set where a case runs in Context, and its data in `Variants`. Keep both out
of the Intent's meaning:

| Dimension | Field |
| --- | --- |
| Persona or role | `Context.agent`, an [agent](https://e2e.tester.army/docs/agents#pin-an-agent-in-the-suite) by name |
| Platform, capability, signed-in state | `Context.platforms`, `Context.requires`, `Context.session` |
| Data: codes, amounts, locales | `Variants[].params`, used as `{name}` placeholders |

Each variant runs as its own test, tagged `cige:<id>/<variant>`, with its
own run summary.

## Guardrails

Every guardrail is added to each `act` instruction, so the acting agent
reads it; the judges don't. A guardrail with `deny` is also checked by the
runner after every action of an `act` step, replayed ones included, and a
match stops the step with `POLICY_DENIED`:

| `deny` | Matches |
| --- | --- |
| `actions` | An action name such as `tap`, `navigate`, or `tool:refund`, or a prefix ending in `*`. Prefer this one |
| `summary` | A regular expression tested against the runner's prose for the action. Best effort: that prose is not a stable contract |

> **Note:** `onAction` runs after an action, so a `deny` rule stops the step right
> after it; it can't prevent it. Keep tests that could cause damage out of
> environments where that damage counts.

## Classify and repair with the cige skill

After a run the `cige()` reporter writes `.e2e/cige/<id>.run-summary.json`:
the failing step, a first guess at the failure type, and the commands that
fetch the refs and replay the case. The
[README](README.md)
lists every field. The `cige` skill starts from it and names the one repair
allowed:

| Classification | The skill | May change |
| --- | --- | --- |
| Infrastructure | Restores the environment with `cige env` | Nothing in the case. Context only as a proposal for a human |
| Outdated test logic | Rewrites the path, after it looks at the live app over [`e2e mcp`](https://e2e.tester.army/docs/mcp-server) | `Execution` |
| False positive | Makes the case stricter | Adds guardrails, deny patterns, criteria, or evidence |
| Product defect | Files a bug, or proposes an Intent change when the spec and release notes agree | Nothing on its own |

```bash
npx skills add vivekkrishna/cige
```

## Replay a repair and check it

`cige replay` resets the case's environment and runs the case alone
with the replay cache off. `cige diff` then checks the change against
the field rules, from the branch's merge base. Run `diff` in CI too:

```bash
npx cige replay checkout-discount
npx cige diff --base origin/main
```

`diff` exits 1, and the change needs a human's approval, when it weakens or
redirects what a pass means:

- The Intent statement changed, or a criterion, evidence item, guardrail,
  deny pattern, variant, or case was removed, or a judgment turned off.
- Any Context changed: the environment, the agent, a precondition.
- The CIGE config, or a module it imports, changed: that's where the hooks
  and plugins a pass depends on live. `#` aliases, workspace packages and
  the ones they depend on, a hook's lazy imports, links, and the
  package.json that maps them count. A workspace package's sources resolve
  `./x` and `./x.js` to `x.ts`, as their bundler does. A config that `diff`
  can't load or follow blocks, such as one that imports `node:vm` or by a
  computed name, or a package source whose relative import leaves every
  workspace package and doesn't resolve.

Rewriting Execution and adding guardrails, deny patterns, criteria,
evidence, or variants pass. `diff` follows the imports the code names, so a
load built from strings, a computed load in a workspace package's sources, a
file a hook runs in a child process or reads as data, app code the config
doesn't import, and installed packages are out of its reach. It catches the
changes a person or an agent makes in good faith, and it's no boundary
against code written to get past it.
`--allow-intent` exits 0 anyway and records nothing, so gate it on a
human's approval in CI; an agent never passes it.

> **Note:** `diff` loads the config to find its modules, so it runs the branch's
> top-level config code. Give the CI job the env `e2e run` gets: a
> config that reads a missing variable at load blocks every `diff`. Run it
> only where you'd run the branch's tests.

## Extend CIGE

- **Your own fields:** any object in a case accepts keys that start with
  `x-`, such as `"x-owner"` or `"x-deny-host"` on a guardrail. Hooks and
  plugins read them; the model never sees them unless a plugin adds them.
- **Your own behavior:** `plugins` in the config add context lines,
  guardrail checks, classification and summary changes, readiness gaps,
  and step kinds.
- **Your own steps:** an Execution entry
  `{ "id": "e4", "use": "order-api", "with": {...} }` runs a step kind a
  plugin registered.

The [README](README.md)
has the plugin reference and an example.

## Run the same cases on Vibium

[Vibium](https://vibium.com) drives a browser with an agent of its own and
has no test runner, so the `cige` command runs the loop. The case doesn't
change: only the config names the runner.

```bash
npm install -D e2e-cige vibium
```

```ts title="cige.config.ts"
import { defineCige } from 'e2e-cige/core';
import { vibiumRunner } from 'e2e-cige/vibium';

export default defineCige({
  root: new URL('.', import.meta.url),
  hooks: { orderExists: async () => (await fetch('http://localhost:3000/api/orders/latest')).ok },
  environments: { staging: { baseURL: 'http://localhost:3000', reset: () => fetch('http://localhost:3000/api/reset', { method: 'POST' }) } },
  runners: { vibium: vibiumRunner({ model: { provider: 'anthropic', model: '<model id>' } }) },
});
```

```bash
npx cige check            # names what Vibium can't enforce or serve for each case
npx cige run              # each case in its own session; summaries in .e2e/cige/
npx cige rejudge checkout # after an Intent edit: judge it again on the stored recording
```

Each act step is one `page.run` with the Context and guardrails in its
goal; each verify a `page.check`; and the Intent is judged with
`browser.check` on the stopped recording, so the judge is not the agent
that acted. A hook gets `{ browser, page }`. Vibium can't watch each action, so
`deny.actions` rules are advisory there; to enforce one, add a request
rule, which Vibium blocks with `page.route`:

```json
{ "id": "no-payments", "rule": "Never submit a real payment", "x-deny-requests": ["POST **/payments*"] }
```

With e2e installed too, `npx cige run --runner e2e,vibium` runs each case
on both and writes their summaries side by side, and `npx cige run
--runner auto` runs each case on the one that suits it best right now (the
one that enforces its guardrails, is available, and can replay a passing
run); add `--dry-run` to see each choice and why.

## Run the same cases on Playwright Test

Your team already runs Playwright Test, so keep it. Each case's Execution
becomes Playwright code once, and CI runs that code with no model calls.
Every failure gets a summary that tells Playwright's healer whether it may
fix it.

```bash
npm install -D e2e-cige @playwright/test
npx cige compile checkout      # writes checkout.cige.spec.ts: one stub per step
```

Fill each stub with the Playwright code for its step, or have an agent
do it. A `verify` checks with `expect`:

```ts title="tests/checkout.cige.spec.ts"
import { expect } from '@playwright/test';
import { cigeTest } from 'e2e-cige/playwright';
import config from '../cige.config.ts';

cigeTest(config, 'checkout', {
  e1: async ({ page }) => { await page.getByRole('button', { name: 'Add to cart' }).click(); },
  e2: async ({ page }) => { await expect(page.getByTestId('total')).toHaveText('$45.00'); },
});
```

```ts title="cige.config.ts"
import { defineCige } from 'e2e-cige/core';
import { playwrightRunner } from 'e2e-cige/playwright';

export default defineCige({
  root: new URL('.', import.meta.url),
  hooks: { orderExists: async ({ request }) => (await request.get('/api/orders/last')).ok() },
  runners: { playwright: playwrightRunner() },
  runner: 'playwright',
});
```

Add the reporter to `playwright.config.ts`, then run Playwright as usual
or through `cige`:

```ts
reporter: [['list'], ['e2e-cige/playwright/reporter', cige]],   // import cige from './cige.config.ts'
```

```bash
npx playwright test       # or: npx cige run
npx cige healer           # after npx playwright init-agents: add the CIGE rule to its healer
```

The spec file holds the Execution only, so it is what a repair edits.
The Intent, the Guardrails, and the evidence hooks stay in the case and
the config, where `cige diff` guards them. Playwright has no agent to
judge the screen, so prove the Intent with hook evidence and set
`"judge": false`, or give `playwrightRunner` a `judge`. A guardrail's
`x-deny-requests` is enforced with `context.route()`. The rest is in
[docs/playwright.md](docs/playwright.md), and `examples/playwright` is a
working project.

## Next

- [Agents and personas](https://e2e.tester.army/docs/agents): Pin a case to an agent, or run it as several personas.
- [The cige skill](skills/cige/SKILL.md): `npx skills add vivekkrishna/cige`, for a coding agent that classifies and repairs cases.
- [Writing a runner adapter](docs/adapters.md): run CIGE cases on another tool, and prove it routes failures the same way.
