# Writing a CIGE runner adapter

A runner adapter lets CIGE cases run on another tool (Stagehand,
Midscene, your own harness) without changing a case. Everything an adapter
needs is in `e2e-cige/runner`. It must not change what a case means: the
same failure has to reach the same `failureType` on your runner as on
e2e and Vibium, and the conformance kit checks that.

## The shape of an adapter

An adapter is a `CigeRunner`: a name, its tool's version, what it can do,
and `start`, which opens one case's session.

```ts
import type { CigeRunner, CigeSession } from 'e2e-cige/runner';
import { CigeError, signalsForCode } from 'e2e-cige/runner';

export function myRunner(options: MyOptions = {}): CigeRunner<MyFixtures> {
  return {
    name: 'mine',
    version: '1.2.3',
    capabilities: {
      platforms: ['web'],
      mode: 'owned',          // CIGE runs the loop (`cige run`)
      replay: 'agentic',
      actionEvents: false,    // true only if you call a hook after every action
      networkDeny: true,      // true only if you enforce `x-deny-requests`
      archiveJudge: false,    // true if you implement `rejudge`
      sessions: false,
    },
    async start({ testCase, environment, plugins, outputDir, name, attempt }) {
      const tool = await import('my-tool');   // load your tool only now
      // …open a browser, start a recording under outputDir, named after `name` and `attempt`…
      return session;
    },
  };
}
```

`cige run --runner mine` finds it under `runners.mine` in the CIGE
config. A hosted adapter, one whose own test runner owns the loop the way
e2e does, registers the cases with that runner and reads its report back
into `CigeRunRecord`s for `writeSummaries` (`e2e-cige/core`); see
`src/adapters/e2e` and `src/adapters/playwright` for the pattern. Give it
`launch(request)`, returning the Node script of its command and the
arguments for the tags, `--last-failed`, workers, and retries `cige run` and
`cige replay` ask for, and its reporter should honor `RUNNER_SUFFIX_ENV`
and `selectionsFor(name)` from `e2e-cige/core`, as both hosted adapters do.

`readiness(testCase, { root })` names what the runner needs of a case
beyond its capabilities. `blocking` reasons make `auto` skip the runner for
that case and show in `cige check`; `advisory` ones only show in `cige
check`. Playwright, for one, blocks a case no spec binds.

## The session

`executePlan` runs every case through one loop: preconditions, then
`Context.open`, then each Execution entry, then the evidence, then the
Intent. It calls your session for the parts only your tool can do.

| Method | Does | Fails with |
| --- | --- | --- |
| `open(url)` | Navigates; resolve against `environment.baseURL` | `ENVIRONMENT_UNAVAILABLE` when the app isn't there |
| `act(op)` | Reaches `op.instruction` (the step with the guardrail block); `op.params` are the step's values | The signal your tool's outcome means (below) |
| `verify(op)` | Judges `op.text` true or false | `assert.false`, or `assert.inconclusive` |
| `judge(op)` | Judges the Intent (`op.text`) | As `verify` |
| `group(op, run)` | Wraps one operation in your record (a recording group), named by its id | — |
| `failure(code, message, { cause, op })` | The error a hook or step failure is on your runner | Return `new CigeError(code, message, { cause, signals: signalsForCode(code, op) })` |
| `keeps(cause, site)` | Whether a hook's throw already carries a verdict | `isCigeError(cause)` |
| `stop()` | Ends the session | Return `{ recording, groups, native }` |

Resolve to pass; throw a `CigeError` with the neutral signals to fail.
Put the Context in front of every goal and claim if your tool has no
system context of its own: `renderAgentContext(testCase, plugins)` is what
e2e sends as `agentContext`. A hook gets your `fixtures` and
`{ runner: name }`.

## Signals, not failure types

Never set a failure type. Translate what your tool reports into neutral
signals, and `classify` routes them the same way for every runner:

| Your tool says | Signal |
| --- | --- |
| The browser, the app, a credential, seed data isn't there | `env.unavailable` |
| The model provider failed (a key, a quota) | `provider.error` |
| The step's target is gone, ambiguous, or the action on it failed | `step.target-missing`, `step.target-ambiguous`, `step.action-failed` |
| A recorded path no longer replays | `step.stale-replay` |
| The goal couldn't be reached | `step.goal-unreached` |
| A budget, the clock, an unsupported action | `step.limit` |
| The agent stopped for information it wasn't given | `step.missing-information` |
| You blocked an action or request a guardrail forbids | `guardrail.violated` with `detail: <guardrail id>` |
| The agent stopped itself, citing a guardrail | `guardrail.refused`, with `detail` when it named one |
| A check said false | `assert.false` |
| A check couldn't decide | `assert.inconclusive` |

A signal you can't tell from your tool's outcome is one you leave out:
an untyped failure is read by the classifying agent, and a wrong type
starts the wrong repair.

## Prove it: the conformance kit

```ts
import { checkConformance, conformanceHooks, conformancePlugin, CONFORMANCE_MARKERS, CONFORMANCE_SCENARIOS } from 'e2e-cige/runner';
```

1. Write each scenario's `case` to a `.cige.json` file, with
   `conformanceHooks` and `conformancePlugin` in the config.
2. Script your tool (a stub, or a fixture app) to report each scenario the
   way it natively would; each scenario's `native` says what, and its steps
   carry a phrase from `CONFORMANCE_MARKERS` to key the script on.
3. Run the cases on your runner, read the summaries, and pass them, by
   case id, to `checkConformance(summaries, unsupported)`.

`report.problems` must be empty. `unsupported` lists, with the reason, each
scenario your tool can't produce at all; Vibium lists `stale`, since an
agentic run has no recorded path to go stale. Never fake one.
`tests/conformance.test.ts` in this repository runs the kit on e2e and
Vibium from one project.
