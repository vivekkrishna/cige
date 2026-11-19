/**
 * Plugins: a customer's own behavior, declared in `cige.config.ts` beside
 * the cases. A plugin can add model-visible context (the one way an `x-`
 * field reaches the model), stop an act step on an action the built-in
 * `deny` rules can't express, adjust the reporter's first classification,
 * add fields to a run summary, report readiness gaps, and register step
 * kinds an Execution entry runs with `"use"`. Plugins are your code, with
 * the runner's full OS authority, as hooks are.
 */

import type { CigeClassification, CigeFailureType } from './classify.ts';
import type { CigeUseStep } from './plan.ts';
import type { CigeRunRecord } from './record.ts';
import { CigeValidationError, ID_PATTERN, type CigeCase } from './schema.ts';
import type { CigeRunSummary } from './summary.ts';

export type { CigeUseStep } from './plan.ts';

/** The runner a plugin's runner-bound hooks (`steps`, `onAction`) serve when it names none: the one plugins were first written for. */
export const DEFAULT_PLUGIN_RUNNERS: readonly string[] = ['e2e'];

/**
 * An action a runner reports after it happened, for `onAction`: e2e's
 * `ActionEvent` is one. Only runners with per-action events call it.
 */
export interface CigeActionEvent {
  /** The committed action, e.g. `tap` or `navigate`; a mutating project tool reads `tool:<name>`. */
  readonly action: string;
  /** What the action did. */
  readonly summary: string;
  /** `model` when the agent chose the action, `replay` when a cache replayed it. */
  readonly source: string;
}

/**
 * What a plugin's step runs with: the runner's fixtures (e2e's test fixtures,
 * Vibium's `{ browser, page }`), the resolved case, the step, and the runner.
 */
export interface CigeStepContext<Fixtures = unknown> {
  readonly fixtures: Fixtures;
  readonly testCase: CigeCase;
  readonly step: CigeUseStep;
  /** The runner running the step, such as `e2e` or `vibium`. */
  readonly runner: string;
}

/**
 * A step kind's code. Return to pass. Throw a `CigeError` (or, on e2e, an
 * `AgentError`) such as `ASSERTION_FAILED` for a check that failed to keep
 * its code; any other throw fails the step as `plugin-step-failed`, naming it.
 */
export type CigeStepRunner<Fixtures = unknown> = (context: CigeStepContext<Fixtures>) => unknown;

/** An action a plugin refuses: the guardrail it breaks, by id, and why. */
export interface CigeGuardrailViolation {
  readonly guardrail: string;
  readonly reason: string;
}

/** What a plugin's `classify` changes: a failure type (`null` clears it), and signals to add. */
export interface CigeClassificationChange {
  readonly failureType?: CigeFailureType | null;
  readonly signals?: readonly string[];
}

/**
 * A plugin. `Result` is what `classify` gets as `result`: on e2e the report
 * result, on another runner its native record of the case. `Event` is the
 * action `onAction` sees.
 */
export interface CigePlugin<Fixtures = unknown, Result = unknown, Event extends CigeActionEvent = CigeActionEvent> {
  /** Lowercase letters, digits, and dashes; unique among the config's plugins. Names its summary fields and gaps. */
  readonly name: string;
  /**
   * The runners whose fixtures its `steps` and `onAction` are written for;
   * default `['e2e']`, and `['*']` for steps that use no fixtures. Its `context`, `classify`, `summarize`, and
   * `readiness` take no fixtures and serve every runner.
   */
  readonly runners?: readonly string[];
  /** Lines added to the case's `agentContext`, which every agent step reads. */
  readonly context?: (testCase: CigeCase) => string | readonly string[] | undefined;
  /** Called after every action of an `act` step, beside the `deny` rules; a violation stops the step with `POLICY_DENIED`. Runners with per-action events only. */
  readonly onAction?: (event: Event, testCase: CigeCase) => CigeGuardrailViolation | undefined;
  /** Adjusts the first classification of a result. */
  readonly classify?: (input: {
    readonly testCase: CigeCase;
    /** The runner's native result: on e2e the report result. */
    readonly result: Result;
    readonly classification: CigeClassification;
    /** The neutral record of the result, whichever runner ran it. */
    readonly record: CigeRunRecord;
  }) => CigeClassificationChange | undefined;
  /** Fields added to a run summary, under `extensions.<plugin name>`. */
  readonly summarize?: (input: { readonly testCase: CigeCase; readonly summary: CigeRunSummary }) => Readonly<Record<string, unknown>> | undefined;
  /** Readiness gaps for `cige check` and the `CIGE gaps` row: a message, a list of them, or none. */
  readonly readiness?: (testCase: CigeCase) => string | readonly string[] | undefined;
  /** Step kinds an Execution entry runs with `{ "use": "<kind>", "with": {...} }`. */
  readonly steps?: Readonly<Record<string, CigeStepRunner<Fixtures>>>;
}

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A plugin typed for any runner: these helpers read only its names and shapes. */
export type AnyPlugin = CigePlugin<any, any, any>;

/** Every problem with a set of plugins: a malformed or repeated name, or a step kind two plugins register. */
export function pluginProblems(plugins: readonly AnyPlugin[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const kinds = new Map<string, string>();
  for (const plugin of plugins) {
    if (!PLUGIN_NAME.test(plugin.name)) problems.push(`plugin name ${JSON.stringify(plugin.name)}: use lowercase letters, digits, and dashes`);
    // A summary's `extensions` holds the case's own `x-` keys beside each plugin's fields, by name.
    else if (plugin.name.startsWith('x-')) problems.push(`plugin name ${JSON.stringify(plugin.name)}: x- names are the case's own fields`);
    if (names.has(plugin.name)) problems.push(`plugin "${plugin.name}" is listed twice`);
    names.add(plugin.name);
    for (const kind of Object.keys(plugin.steps ?? {})) {
      if (!ID_PATTERN.test(kind)) problems.push(`plugin "${plugin.name}": step kind ${JSON.stringify(kind)} is not an id a case's "use" can name`);
      const other = kinds.get(kind);
      if (other !== undefined) problems.push(`step kind "${kind}" is registered by both "${other}" and "${plugin.name}"`);
      kinds.set(kind, plugin.name);
    }
  }
  return problems;
}

/** Whether a plugin's runner-bound hooks serve a runner. */
export function servesRunner(plugin: AnyPlugin, runner: string): boolean {
  const runners = plugin.runners ?? DEFAULT_PLUGIN_RUNNERS;
  return runners.includes('*') || runners.includes(runner);
}

/** The step a plugin registered for a kind, on a runner (default e2e). */
export function stepRunnerOf<Fixtures>(plugins: readonly CigePlugin<Fixtures, any, any>[], kind: string, runner = 'e2e'): CigeStepRunner<Fixtures> | undefined {
  for (const plugin of plugins) {
    if (!servesRunner(plugin, runner)) continue;
    const steps = plugin.steps ?? {};
    if (Object.hasOwn(steps, kind)) return steps[kind];
  }
  return undefined;
}

/** Every `use` step kind the case names that no plugin registers for the runner. */
export function missingStepKinds(testCase: CigeCase, plugins: readonly AnyPlugin[], runner = 'e2e'): string[] {
  const kinds = testCase.execution.flatMap((step) => (step.kind === 'use' ? [step.use] : []));
  return [...new Set(kinds)].filter((kind) => stepRunnerOf(plugins, kind, runner) === undefined);
}

/** The context lines every plugin adds for a case. A plugin that throws fails collection, naming it. */
export function pluginContext(plugins: readonly AnyPlugin[], testCase: CigeCase): string[] {
  return plugins.flatMap((plugin) => {
    if (plugin.context === undefined) return [];
    let lines: string | readonly string[] | undefined;
    try {
      lines = plugin.context(testCase);
    } catch (cause) {
      throw new CigeValidationError(testCase.file ?? testCase.id, [`plugin "${plugin.name}" context failed: ${cause instanceof Error ? cause.message : String(cause)}`]);
    }
    if (lines === undefined) return [];
    return (typeof lines === 'string' ? [lines] : [...lines]).filter((line) => line.trim() !== '');
  });
}
