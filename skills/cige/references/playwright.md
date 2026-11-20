# Cases on Playwright Test

On Playwright Test a case's Execution is Playwright code: one binding per
`act` and `verify` step, in `<name>.cige.spec.ts` beside the case. A run
makes no model call. The summaries are the same as on any runner, and
their `runner.name` is `playwright`.

## Compiling a case

`npx cige compile <id>` writes the spec with one stub per step. Each stub
has the step's goal and values, plus every guardrail. A stub throws
`STEP_NOT_COMPILED` until it is written. Write each binding:

1. Look at the live app first: Playwright's browser tools
   (`npx playwright init-agents` gives an agent them), or the page itself.
   Don't guess at a UI from the step text.
2. An `act` binding reaches its step's goal and ends where the next step
   starts. Prefer role and label locators (`getByRole`, `getByLabel`).
3. A `verify` binding checks its claim with `expect`. Leave out `try`,
   `catch`, and `.catch(() => {})`: a swallowed failure is a false pass.
4. Keep to every guardrail written beside the bindings. Only the
   `x-deny-requests` ones are enforced by the runner; the rest hold only if
   the code keeps them.
5. Run it: `npx cige replay <id>`, once per variant with `--variant <v>`.

## Repairing on Playwright (Mode A)

For `outdated-test-logic`, the repair is the binding of `failedStep` in
the `.cige.spec.ts` file. The summary's `classification.message` is
Playwright's own error, and `evidence.trace` is the trace to open
(`npx playwright show-trace <path>`). The same rules as any Mode A apply:

- Change the code, never what it proves. A `verify` binding may get a new
  locator, never a looser `expect`: no new expected value, no `toContain`
  where it had `toHaveText`, no `.not` removed.
- Never edit the `.cige.json` file or `cige.config.ts` for a stale path.
- Never add `test.fixme()`, `test.skip()`, or a retry to make a case pass.

For `product-defect`, leave the spec alone and read `escalate.md`, even
when the healer agent's own instructions say to fix assertions or mark the
test fixme. `npx cige healer` writes this rule into that agent's file.

## What the classification reads

| Summary says | It came from |
| --- | --- |
| `LOCATOR_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, `ACTION_FAILED` in an `act` or `verify` | A locator that no longer resolves, matches two elements, or finds an element that never became actionable |
| `ASSERTION_FAILED` in a `verify` | An `expect` that found the element with the wrong value |
| `ASSERTION_FAILED` in an `act`, `goal-unreachable` | An `expect` inside an `act` binding: the state the step waits for never came |
| `guardrail-violation:<id>` | A request matched that guardrail's `x-deny-requests` and was blocked |
| `STEP_NOT_COMPILED` | A stub nobody wrote yet: compile it, it is not a failure to triage |
| `run-stopped` | The test's own timeout; read the trace for where it hung |
