# e2e-cige

A community package for [e2e](https://github.com/tester-army/e2e), and the
home of the CIGE model for any runner that adapts to it. e2e and
[Vibium](https://vibium.com) adapters ship here; both are optional peers,
so install the one you run:

```bash
npm i -D e2e-cige e2e      # cases as e2e tests (hosted: e2e runs the loop)
npm i -D e2e-cige vibium   # cases on Vibium (owned: cige run runs the loop)
```

On e2e, also install the engine and model packages your e2e config names,
such as `@e2e-dev/web` and `@ai-sdk/anthropic`.

The command is `cige`: `npx cige check`, `npx cige diff`, and the rest under
[Commands](#commands).

Run [CIGE](https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard)
test cases with e2e or Vibium, or let `auto` pick per case. A CIGE case keeps the stable meaning of a test apart
from the parts that drift:

- **Context**: where the test runs.
- **Intent**: why it exists and what a pass needs.
- **Guardrails**: what the agent must never do.
- **Execution**: the first path to try.

The [CIGE guide](GUIDE.md) shows how to write a
case, set up the config, and run it. This README is the reference.

## Contents

- Entry points
- Config
- Runners
- How a case runs
- Variants
- Run summaries
- Commands
- What `diff` blocks
- Extending
- Developing

## Entry points

| Import | Holds | Needs |
| --- | --- | --- |
| `e2e-cige` | The 0.x API: `defineCige`, `cigeSuite`, the `cige()` reporter, `runCige`, and the model, typed for e2e | e2e |
| `e2e-cige/core` | The CIGE model with no runner in it: the schema and loader, variants, refs, `diff`, readiness, the plan, signals, `classify`, `auto` routing, and the summary writer | nothing |
| `e2e-cige/runner` | What an adapter is built from: the runner contract, the shared `executePlan` loop, `CigeError`, and the conformance kit ([docs/adapters.md](docs/adapters.md)) | nothing |
| `e2e-cige/e2e` | `e2eRunner`, `cigeSuite`, `cige()`, typed for e2e | e2e |
| `e2e-cige/vibium` | `vibiumRunner`, which loads `vibium` only when a case runs on it | vibium, to run |
| `cige` | The command: `run`, `replay`, `rejudge`, `env`, `refs`, `check`, `diff` | either runner, to run cases |

Tested with e2e 0.21.3 and 0.23.1 (peer range `>=0.21.0 <1`) and Vibium
26.11.16 (`>=26.11.16`), on Node `^22.22.3 || >=24.8.0`.

## Config

`cige.config.ts` exports `defineCige({...})`. `cigeSuite(config)` registers
the cases, `cige(config)` in the e2e config's `reporters` writes the
summaries, and `cige` reads the same file. The command loads it with
plain Node and its type stripping, so use only TypeScript that erases to
JavaScript, and package.json `imports` rather than tsconfig `paths`.

| Option | Does |
| --- | --- |
| `cases` | Globs of `.cige.json` files; default `tests/**/*.cige.json` |
| `root` | Directory the globs resolve against. Set `new URL('.', import.meta.url)` so the suite, reporter, and command agree |
| `hooks` | Precondition and evidence hooks a case names, run inside the test with its fixtures |
| `environments` | By name: `config` (the e2e config that reaches it), and `provision`, `reset`, `teardown` actions. Once set, every `Context.environment` must name one |
| `refs` | `spec`, `build`, `expected` resolvers, run only by `cige refs` and `check --resolve`, never during a run. What they return is written for an agent to read, so never return a secret |
| `plugins` | See [Extending](#extending) |
| `build` | The build under test, such as `process.env.GITHUB_SHA`: each summary's `build`, and `{build}` in a ref |
| `outputDir` | Where summaries go; default `cige` beside `report.json` |
| `e2eConfig` | The e2e config the cases run under, when it isn't the nearest `e2e.config.ts`; a replay passes it |
| `configFile` | This file's path, when it isn't `cige.config.ts` at the project root; the commands a summary prints pass it as `--config` |
| `runners` | The runners cases can run on, by name: `e2e: e2eRunner({ config })`, `vibium: vibiumRunner({...})`. See [Runners](#runners) |
| `runner` | The runner a case runs on when `--runner` and its environment name none, or `auto` |
| `auto` | `prefer`: the order `auto` breaks ties in; default `['e2e', 'vibium']` |

An environment also takes `runner` (its cases' default runner) and
`baseURL` (the site under test, for an owned runner). Its `config` is a
deprecated alias for `e2eRunner({ config })`.

## Runners

The case never names a tool: Context names an environment, so one case
runs anywhere. The runner is picked when the cases run: `--runner`, then
the environment's `runner`, then the config's `runner`, then the config's
only runner when it lists one, then e2e when it is installed, then Vibium.

```ts
// cige.config.ts
import { defineCige } from 'e2e-cige';
import { e2eRunner } from 'e2e-cige/e2e';
import { vibiumRunner } from 'e2e-cige/vibium'; // loads vibium only when a case runs on it

export default defineCige({
  root: new URL('.', import.meta.url),
  environments: { staging: { baseURL: 'https://staging.example.com', reset } },
  runners: {
    e2e: e2eRunner({ config: './e2e.config.ts' }),
    vibium: vibiumRunner({ start: { headless: true }, model: { provider: 'anthropic', model: '…' }, judge: 'archive' }),
  },
  runner: 'e2e',
});
```

| | e2e | Vibium |
| --- | --- | --- |
| Mode | Hosted: `cigeSuite` registers the cases, the `cige()` reporter writes summaries | Owned: `cige run` runs each case in its own session and writes summaries |
| An act step | `agent.act`, with the Context as `agentContext` | `page.run`, with the Context and the step's values in the goal |
| A verify, a judged evidence item | `agent.assert` | `page.check` |
| The Intent | `agent.assert` on the screen | `browser.check` on the stopped recording (`judge: 'archive'`), apart from the agent that acted; or `page.check` (`judge: 'live'`) |
| Repeat runs | Recorded and replayed, no model calls until the app changes | Agentic every run |
| Platforms | Whatever the targets declare | Web |
| Evidence | `report.json`, the trace, artifacts | The recording zip, a group per operation |

Guardrails reach the acting agent as text on both. What each enforces:

| Rule | e2e | Vibium |
| --- | --- | --- |
| Guardrail prose on every act step | Yes | Yes |
| `deny.actions`, `deny.summary`, plugin `onAction` | Enforced after every action | Advisory: `run` is one call with no action events |
| `x-deny-requests: ["POST **/payments*"]` on a guardrail | Advisory | Enforced: `page.route` aborts the request and the step fails as that guardrail's violation |
| The agent stopping itself | `POLICY_DENIED` citing a guardrail | `run` ends `safety_stop` |

`cige check` names each rule that is only advisory on the runner a case
resolves to, with the platforms, sessions, and step kinds it can't serve.

**`auto`.** Set `runner: 'auto'` (on the config or an environment) or pass
`--runner auto`, and each case is routed to one runner just before it
runs. A runner is left out when it isn't available now (not installed; for
Vibium, no model, or no key for its provider), doesn't run the case's
platforms, has no plugin for one of its step kinds, or can't restore its
session. Of the rest it picks, in order: the one that only advises the
fewest guardrails; one that didn't fail as infrastructure on its last run
of the case; one that can replay its last passing run with no model calls
(e2e); then `auto.prefer` order (default `['e2e', 'vibium']`). The summary
records why in `runner.selected`, and its replay command names the runner,
so `cige replay` and `cige rejudge` repeat the run they follow. `cige run
--dry-run` prints each case's runner and reason without running anything,
and a case no runner can serve stops the run before it starts. `auto`
never switches runners inside a case or reruns a failure on another: that
would hide the stale path or defect the case is there to catch.

A hook gets the runner's fixtures (e2e's test fixtures, Vibium's
`{ browser, page }`), the case, and `{ runner }`. A plugin's `steps` and
`onAction` serve the runners in its `runners` (default `['e2e']`; `['*']`
for a step that uses no fixtures); `context`, `classify`, `summarize`, and
`readiness` serve every runner. Throw a `CigeError` from `e2e-cige` (or
`e2e-cige/core`) in a hook meant for both runners; e2e reads it as the
`AgentError` with that code.

A matrix run, `cige run --runner e2e,vibium`, runs each case on both and
writes `<id>.e2e.run-summary.json` and `<id>.vibium.run-summary.json`
side by side: one case, two runners, comparable verdicts. A case run on a
runner other than its default is named the same way, so it never
overwrites the default runner's summary. Each runner clears only its own
summaries. `e2e-cige/runner` holds the contract, the shared loop, and the
conformance kit for a third-party adapter: see [docs/adapters.md](docs/adapters.md).

## How a case runs

1. Each precondition hook. It fails only by throwing.
2. `app.open(Context.open)`, when set, so the page loads what the hooks seeded.
3. Each Execution entry: a `step` is one `agent.act` goal with the
   guardrails appended, a `verify` one `agent.assert`, a `use` a plugin's
   step kind.
4. Each piece of evidence. A `hook` holds only when it returns `true`; any
   other value is `ASSERTION_FAILED`. A throw means the check couldn't run:
   an e2e error keeps its code, any other is `ASSERTION_INCONCLUSIVE`.
5. `agent.assert` of the Intent with its `success` and `failure` criteria,
   unless `"judge": false`. Such a case needs evidence or a `verify`, or it
   fails to load.

Context reaches the model as the test's `agentContext`: the system,
environment, actor, preconditions, `facts`, and the files `prompts` names.
The refs, `tools`, and `x-` keys never do.

## Variants

`Variants` runs one case per combination: each variant fills the `{name}`
placeholders in Intent, Execution, evidence, and a `use` step's `with`, and
may override `platforms`, `agent`, and `session`. An `act` step gets the
value as a param; a judgment gets it filled into its text; a `with` string
that is one whole placeholder keeps the value's type. A placeholder nothing
fills, or a param that fills none, fails to load. Each variant is tagged
`cige:<id>/<variant>` and gets its own summary.

## Run summaries

The reporter writes `<output>/cige/<id>.run-summary.json` per result
(`<id>.<variant>…` for a variant, `<id>.<target>.<agent>…` when a case ran
more than once).

- A full run removes the previous summaries and refs first, and no other file.
- A run that leaves cases out (a tag filter, `cige replay`,
  `--last-failed`) replaces only the summaries of the cases it ran and keeps
  every refs directory. A `--last-failed` rerun also writes one for each
  failure it carried (`carried-from-earlier-run`).
- A test stopped before its verdict gets `result: "interrupted"`.
- The terminal summary gets a `CIGE gaps` row while a case it ran has a
  readiness gap (see `check`).

| Field | Holds |
| --- | --- |
| `result` | `pass`, `fail`, `skipped`, or `interrupted` |
| `failedStep` | The Execution id, evidence id, or `intent` that failed |
| `failureType` | A first guess, below; absent when the evidence can't decide |
| `classification` | `phase`, `errorCode`, `message`, `signals`, and `adjustedBy` when a plugin changed it |
| `specRef`, `buildRef`, `expectedRef` | The case's refs with `{build}` and `{environment}` filled in |
| `resolveRefs`, `replay` | The commands that fetch the refs and replay the result |
| `extensions` | The case's top-level `x-` keys, then each plugin's `summarize` fields under its name |
| `runner` | The runner that produced it, `name` and `version`, and `selected` (`by: "auto"`, `reason`) when `auto` picked it |
| `evidence` | Pointers to `report.json`, the trace page, and the artifacts; on Vibium, the `recording` zip and its `groups` |
| `rejudged` | Set by `cige rejudge`: the run date and verdict it replaced |

`failureType` reads the runner's own error class (`error.category` in
`report.json`) and the step's status, so it follows new codes in e2e:

| What the report says | `failureType` |
| --- | --- |
| A precondition failed, or an `infrastructure` or `configuration` class error (environment, app, credentials, seed data, the model provider), except `POLICY_DENIED` and `REPLAY_STALE` | `infrastructure` |
| An Execution `step` ended `LOCATOR_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, `ACTION_FAILED`, or `REPLAY_STALE` | `outdated-test-logic` |
| A `verify`, evidence, the Intent, or a plugin's check step was judged false (`ASSERTION_FAILED`) | `product-defect` |
| An act step's goal couldn't be reached (`ASSERTION_FAILED`) | Absent, signal `goal-unreachable` |
| A blocked test-class step, a spent budget, the clock, or no conclusion | Absent, signal `automation-limit` |
| A blocked `APP_NOT_OPEN`: the case never opened the app, usually a missing `Context.open` | Absent, no signal |
| A guardrail violation, an agent's refusal citing one, an inconclusive judgment, a plugin step's plain throw | Absent; `guardrail-violation:<id>`, `guardrail-refused:<id>`, `inconclusive-evidence`, `plugin-step-failed:<id>` |

On Vibium, from `run` and `check` results:

| What Vibium says | `failureType` |
| --- | --- |
| `browser.start` fails, or the model provider can't be reached (`PROVIDER_ERROR`), or a precondition throws | `infrastructure` |
| `check` `failed` on a verify, the Intent (judged on the recording), or an evidence hook returns not `true` | `product-defect` |
| `run` `not_completed` with no reason | Absent, signal `goal-unreachable` |
| `run` `action_limit` | Absent, signal `automation-limit` |
| `run` `missing_information` | Absent, signal `missing-information`: check the seed data and the facts Context gives |
| `run` `safety_stop` | Absent, `guardrail-refused[:<id>]` |
| A request an `x-deny-requests` rule blocked | Absent, `guardrail-violation:<id>` |
| `check` `inconclusive` | Absent, `inconclusive-evidence`; `archive-missing-evidence` too when the recording lacked what the judge needed |

Vibium has no recorded path, so it never reports a stale step: a changed
flow either heals in the run or ends `not_completed`. The routing for
every runner lives in one function (`classify` in `e2e-cige/core`); an
adapter only translates its outcomes into neutral signals.

`guardrail-refused` is read from the model's own conclusion (a guardrail's
id, or the word "guardrail"), so it is best effort, like `deny.summary`:
read the trace before acting on it. `guardrail-violation` is the runner's
own record of a `deny` match.

A pass with no evidence hook carries `screen-only-evidence`: check it for a
false positive. A failure without a spec or build ref (and no resolver)
carries `missing-spec-ref` or `missing-build-ref`.

## Commands

```bash
npx cige run [<id>...] [--runner <name>[,<name>]|auto] [--tag <tag>] [--workers <n>] [--retries <n>] [--last-failed] [--dry-run] [-- <e2e run options>]
npx cige replay <id> [--variant <v>] [--runner <name>] [-- <e2e run options>]
npx cige rejudge <id> [--variant <v>] [--runner vibium]
npx cige env <provision|reset|teardown> <environment>
npx cige refs <id> [--variant <v>] [--build <build>]
npx cige check [--resolve] [--warn] [--json] [--runner <name>[,<name>]]
npx cige diff [--base origin/main] [--json] [--allow-intent]
```

Every command takes `--config <file>`; the default is `cige.config.ts` in
the working directory.

- `run` runs the cases on their runner. On e2e it hands off to
  `e2e run --tag cige` (or one `--tag` per selected case) and exits with
  e2e's code; on Vibium it runs each case here, with `--workers` (default
  1, since hooks often share state), `--retries`, and `--last-failed`
  (this runner's failed summaries), and exits 1 on any failure.
- `replay` runs the declared environment's `reset` (it refuses one without
  `reset`; declare a no-op one when it keeps no state), then the case
  alone: on e2e `e2e run --tag cige:<id> --no-cache` with the environment's
  `config`, exiting with e2e's code; on Vibium, one session. A case whose
  environment is prose runs as is.
- `rejudge` judges the Intent again, as the case reads now, on the
  recording the case's last Vibium run stored, without a browser, and
  rewrites that summary with `rejudged`. Use it after an Intent edit, to
  regrade old runs. It refuses a run that failed before its Intent was
  judged: replay that one.
- `env` runs one environment action and touches no case.
- `refs` writes `<output>/cige/<id>.refs/`: `index.json` and a text file
  per resolver that returned text. A `pointer` alone is one to read
  yourself; a missing key or an `error` means that ref has no ground truth.
- `check` lists each case's gaps and exits 1 on any, unless `--warn`:

| Gap | Fix |
| --- | --- |
| `no-spec-ref`, `no-build-ref` | Set `Context.specRef` / `buildRef`, or a `refs.spec` / `refs.build` resolver |
| `build-unset` | A ref uses `{build}`; set `build` from CI |
| `environment-unset` | Set `Context.environment` |
| `environment-undeclared`, `environment-no-reset` | Declare the environment, with a `reset` |
| `resolver-failed` | With `--resolve`, a resolver threw |
| `plugin` | A plugin's `readiness` hook named it |
| `runner` | The case's runner can't serve something it needs, or only advises a guardrail it can't enforce |

## What `diff` blocks

`diff` compares every changed `.cige.json`, the CIGE config, and every
module the config imports against the branch's merge base with `--base`.
It loads the config in its own Node process to see what it imports, then
follows the imports each module names that loading didn't reach, such as a
hook's lazy `import('#hooks/x')`, without running them. These count too:

- A workspace package built to an ignored `dist`: its whole directory, and
  each workspace package it depends on, since a bundler may inline one.
- A symlink to a module, since retargeting it changes what loads.
- The `name`, `type`, `main`, `exports`, and `imports` of each module's
  nearest package.json, since remapping an alias redirects a hook.
- A module the branch deleted or renamed.

It exits 1 on any change that needs a human's approval:

| Blocks | Passes |
| --- | --- |
| Intent statement changed; a criterion, evidence item, guardrail, deny pattern, variant, or case removed; a judgment turned off; an id changed; a variant's data changed | Execution rewritten; criteria, evidence, guardrails, deny patterns, or variants added |
| Any Context change, a removed precondition named | A top-level `x-` key changed (triage data) |
| An `x-` key changed under Intent, evidence, or a guardrail | |
| The CIGE config or a module it imports changed | |
| `config-unverified`: `diff` can't load the config or follow its imports | |

`config-unverified` means the config didn't load, or a module it reaches:

- imports by a computed name, or names a relative or `#` path that doesn't
  resolve;
- imports `node:module`, `node:vm`, `node:worker_threads`,
  `node:inspector`, `node:repl`, `node:test`, or a `data:` URL;
- reads `process.getBuiltinModule`, `process.mainModule`, `.constructor`,
  `eval`, `Function`, or `require` other than as a direct call, a JSX tag
  included, or uses `with`;
- doesn't parse;
- is a file git doesn't track, outside any workspace package.

The rules are by name, so `Base.constructor` blocks, but
`err.constructor.name` doesn't, since it reads only a string.

A workspace package's own sources don't block on a load: the package counts
as a whole, and so does what they import by name, in any TypeScript or JSX
(an `enum` or a decorator included). They're bundled, not run by Node, so a
relative import resolves as a bundler's does: `./x` or `./x.js` for `x.ts`,
and `./dir` for its index. A load in them that `diff` can't follow, such as
a computed `import()` or a tsconfig `paths` alias, isn't seen. A source that
doesn't parse blocks there too, and so does a relative import that leaves
every workspace package and doesn't resolve. A module they reach outside
every workspace package is held to all the rules above.

Loading the config runs its top-level code from the branch under review.
Give `diff` the env `e2e run` gets: a config that reads a missing
variable at load blocks every `diff` with `config-unverified`. Run it only
where you'd run the branch's tests. `diff` catches the changes a person or
an agent makes in good faith. It follows the imports the code names and
matches loaders by name, without scopes, so it's no boundary against code
written to get past it: a load built from strings, reached by reflection
(`Reflect.get(module, name)`), or through `process.binding` or
`process.dlopen` isn't seen. Neither is a file a hook runs in a child process or reads as
data, app code the config doesn't import, or an installed package: those
need a human's review.
`--allow-intent` exits 0 anyway and records nothing: gate it on a human's
approval in CI. `--json` reports `intentUnchanged` and the `blocking` count.

## Extending

**`x-` keys.** Every object in a case accepts keys that start with `x-`; any
other unknown key fails to load. The loader keeps them as `extensions`. A
step's `params` and `with` are data and take any key. Put data a plugin
enforces on the guardrail, where `diff` blocks a change, not at the top
level. Keep secrets out: they are committed and copied into summaries.

**Plugins.** `plugins` in the config, each with a `name` (lowercase letters,
digits, dashes, not starting with `x-`) and optional hooks:

Set `runners` on a plugin whose `steps` or `onAction` serve more than e2e.

| Hook | Runs | Does |
| --- | --- | --- |
| `context` | When the suite registers the case | Adds lines to `agentContext`, the only way an `x-` field reaches the model |
| `onAction` | After every action of an `act` step | A returned `{ guardrail, reason }` stops the step with `POLICY_DENIED` |
| `classify` | In the reporter | Sets or clears (`null`) `failureType` on a failure and adds signals |
| `summarize` | In the reporter | Fields under `extensions.<name>` |
| `readiness` | In `check` and the `CIGE gaps` row | A message, a list, or nothing |
| `steps` | When an Execution entry says `use` | Runs a step kind; `with` is its input |

A step kind returns to pass. Throw an `AgentError` to keep its code
(`ASSERTION_FAILED` for a failed check, `ENVIRONMENT_UNAVAILABLE` for a
backend that is down); any other throw is `ACTION_FAILED` naming the step.
Guardrails don't apply to it. Plugins are your code, with the runner's full
OS authority.

```ts
import { AgentError } from 'e2e';
import type { CigePlugin } from 'e2e-cige';

export const shop: CigePlugin = {
  name: 'shop',
  context: (testCase) => {
    const flags = testCase.context.extensions?.['x-feature-flags'];
    return Array.isArray(flags) ? `Feature flags on: ${flags.join(', ')}` : undefined;
  },
  onAction: (event, testCase) => {
    for (const guardrail of testCase.guardrails) {
      const host = guardrail.extensions?.['x-deny-host'];
      if (typeof host === 'string' && event.summary.includes(host)) return { guardrail: guardrail.id, reason: `${host} is off limits` };
    }
    return undefined;
  },
  steps: {
    'order-api': async ({ step }) => {
      const path = String(step.with.path);
      let response: Response;
      try {
        response = await fetch(new URL(path, 'http://localhost:3000'));
      } catch (cause) {
        throw new AgentError('ENVIRONMENT_UNAVAILABLE', `GET ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (response.status >= 500) throw new AgentError('ENVIRONMENT_UNAVAILABLE', `GET ${path} answered ${response.status}`);
      if (response.status !== step.with.expect) throw new AgentError('ASSERTION_FAILED', `GET ${path} answered ${response.status}`);
    },
  },
  summarize: ({ testCase }) => ({ owner: testCase.extensions?.['x-owner'] ?? 'unowned' }),
  readiness: (testCase) => (testCase.extensions?.['x-owner'] === undefined ? 'no x-owner: nobody is paged when it fails' : undefined),
};
```

The `cige` agent skill (`npx skills add vivekkrishna/cige`)
reads the summaries, classifies each failure, and makes only the repair
that kind allows. The file format is pinned by `schema/cige-1.schema.json`,
generated from the loader's schema at build.

## Developing

```bash
npm ci
npm test          # builds first: the end-to-end tests run the built cige command
npm run typecheck
```

The suite runs both runners without a model: e2e for real on an in-memory
engine with a scripted executor, and Vibium as a scripted stand-in. It
covers the conformance kit on both adapters, matrix runs, `auto`, replay,
and rejudge.

The live tests drive real browsers and a real model, so they cost model
calls and run only when asked:

```bash
CIGE_LIVE=1 CIGE_VIBIUM_LIVE=1 \
  ANTHROPIC_API_KEY=... VIBIUM_AI_PROVIDER=anthropic VIBIUM_AI_MODEL=<model> \
  npx vitest run tests/modes.live.test.ts tests/vibium.live.test.ts
```

`tests/modes.live.test.ts` runs one local shop on every runner mode (e2e
with its web engine, Vibium, a matrix, and `auto`); `tests/vibium.live.test.ts`
covers Vibium's enforcement and refusals. Set `CIGE_LIVE_MODEL` to change
the model the e2e side uses. The first run downloads the web engine's
Chromium.

