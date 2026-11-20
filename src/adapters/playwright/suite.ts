/**
 * `cigeTest`: one CIGE case as Playwright tests, from a `*.cige.spec.ts`
 * file. The case's Execution is bound to Playwright code there, step id by
 * step id, and everything that says what a pass means stays where `cige
 * diff` guards it: the Intent, Guardrails, and evidence in the `.cige.json`
 * file, the hooks and the judge in `cige.config.ts`. So the spec file is the
 * one a repair edits, and a repair there can't change what the test proves.
 *
 * One case is one test, or one per variant: its title is the Intent
 * statement, its tags `@cige`, `@cige:<id>` (and `@cige:<id>/<variant>`).
 * It runs while the spec file evaluates, so a missing binding, a hook the
 * config doesn't define, or a case judged on the screen with no judge fails
 * collection, before any test runs.
 */

import path from 'node:path';

import { test as baseTest, type TestInfo, type TestType } from '@playwright/test';

import { DEFAULT_CASES, type CigeConfig } from '../../core/config.ts';
import { denyRequests } from '../../core/deny-requests.ts';
import { executePlan, missingHooks } from '../../core/execute.ts';
import { suffixRequested } from '../../core/hosted.ts';
import { loadCigeCases } from '../../core/load.ts';
import type { CigeOp } from '../../core/plan.ts';
import { missingStepKinds, pluginProblems, type AnyPlugin } from '../../core/plugins.ts';
import { fileSafe } from '../../core/refs.ts';
import { renderAgentContext } from '../../core/render.ts';
import { isCigeError } from '../../core/errors.ts';
import { CigeValidationError, type CigeCase } from '../../core/schema.ts';
import { SUMMARY_SUFFIX } from '../../core/summary.ts';
import { playwrightTag, tagsOf } from '../../core/tags.ts';
import { expandVariants } from '../../core/variants.ts';
import { needsJudge, playwrightRunner, rootOf, type PlaywrightRunner } from './runner.ts';
import { startPlaywrightSession } from './session.ts';
import type { CigeBindings, CigePlaywrightFixtures } from './types.ts';
import { appendVerdict, classifyFailure, failureOf, OUTCOME_ATTACHMENT, verdictLine } from './verdict.ts';

export interface CigeTestOptions {
  /** The `test` to register through, such as one from `test.extend()`; default `@playwright/test`'s. */
  readonly test?: TestType<any, any>;
}

/** A call site as V8 reports it, before any source map: what Playwright maps a test's location from. */
interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** The raw call site of the function that called `cigeTest`: the spec file's line. */
function callerOf(fn: Function): CallSite | undefined {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, frames) => frames;
    const holder: { stack?: NodeJS.CallSite[] } = {};
    Error.captureStackTrace(holder, fn);
    const frame = holder.stack?.[0];
    const file = frame?.getFileName();
    const line = frame?.getLineNumber();
    const column = frame?.getColumnNumber();
    return file === undefined || file === null || line === null || line === undefined || column === null || column === undefined ? undefined : { file, line, column };
  } catch {
    return undefined;
  } finally {
    Error.stackTraceLimit = limit;
    Error.prepareStackTrace = prepare;
  }
}

/** The frame of the call to `fn` as an error's stack prints it, source-mapped: `/path/checkout.cige.spec.ts:12:1`. */
function specFrameOf(fn: Function): string | undefined {
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 1;
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, fn);
    return holder.stack?.split('\n    at ')[1];
  } catch {
    return undefined;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

type Call = (fn: (...args: any[]) => unknown, ...args: unknown[]) => unknown;

/**
 * A caller that calls a function from `site`: Playwright takes a test's
 * location from the frame that calls `test()`, which would otherwise be this
 * package's own file, so the report, the editor, and a healer reading the
 * failure would point into node_modules instead of the spec. The call is made
 * from code whose frame reports the spec's own position; Playwright maps it
 * through the spec's source map exactly as it maps a direct call. Without code
 * generation, or a site, it is a plain call.
 */
function callFrom(site: CallSite | undefined): Call {
  const plain: Call = (fn, ...args) => fn(...args);
  if (site === undefined || /[\r\n]/.test(site.file)) return plain;
  try {
    const pad = `${'\n'.repeat(Math.max(0, site.line - 1))}${' '.repeat(Math.max(0, site.column - 1))}`;
    return (0, eval)(`(function (fn, ...args) {${pad}return fn(...args); })\n//# sourceURL=${site.file}`) as Call;
  } catch {
    return plain;
  }
}

/** The config's Playwright runner: the one it lists, or the defaults. */
export function playwrightOf(config: CigeConfig<any>): PlaywrightRunner {
  const listed = config.runners !== undefined && Object.hasOwn(config.runners, 'playwright') ? config.runners.playwright : undefined;
  if (listed === undefined) return playwrightRunner();
  if (listed.name !== 'playwright') throw new CigeValidationError('the CIGE config', [`runners.playwright is the "${listed.name}" runner; list playwrightRunner() under it`]);
  return listed as PlaywrightRunner;
}

/** Every reason the bindings don't fit the case: a bound step unbound, a binding no step has. */
export function bindingProblems(testCase: CigeCase, bindings: CigeBindings): string[] {
  const problems: string[] = [];
  const steps = new Map(testCase.execution.map((step) => [step.id, step]));
  for (const step of testCase.execution) {
    if (step.kind === 'use') continue;
    const binding = Object.hasOwn(bindings, step.id) ? bindings[step.id] : undefined;
    if (binding === undefined) problems.push(`Execution ${step.id} (${step.kind === 'act' ? 'step' : 'verify'}) has no binding; add ${step.id}: async ({ page }) => { ... } (npx cige compile ${testCase.id} writes the stubs)`);
    else if (typeof binding !== 'function') problems.push(`the binding for ${step.id} is not a function`);
  }
  for (const id of Object.keys(bindings)) {
    const step = steps.get(id);
    if (step === undefined) problems.push(`binding "${id}" names no Execution step of the case (${testCase.execution.map((entry) => entry.id).join(', ')})`);
    else if (step.kind === 'use') problems.push(`binding "${id}" names a "use" step: plugin "${step.use}" runs it, not a binding`);
  }
  return problems;
}

function problemsOf(testCase: CigeCase, config: CigeConfig<any>, runner: PlaywrightRunner, bindings: CigeBindings): string[] {
  const plugins = config.plugins ?? [];
  const problems = [
    ...pluginProblems(plugins).map((problem) => `the CIGE config: ${problem}`),
    ...missingHooks(testCase, config.hooks ?? {}).map((name) => `hook "${name}" is named by the case but not passed in hooks`),
    ...missingStepKinds(testCase, plugins, 'playwright').map((kind) => `step kind "${kind}" is used by the case but no plugin registers it for playwright; set the plugin's runners`),
    ...bindingProblems(testCase, bindings),
    ...denyRequests(testCase).problems,
  ];
  const environment = testCase.context.environment;
  if (config.environments !== undefined && environment !== undefined && !Object.hasOwn(config.environments, environment)) {
    problems.push(`Context.environment "${environment}" is not one of the config's environments (${Object.keys(config.environments).join(', ') || 'none'})`);
  }
  if (needsJudge(testCase) && runner.judge === undefined) {
    problems.push('the case is judged on the screen (the Intent, or an evidence assert), and playwrightRunner has no judge: set judge in cige.config.ts, or prove the Intent with hook evidence and "judge": false');
  }
  for (const name of new Set([testCase.context.session, ...testCase.variants.map((variant) => variant.session)].filter((entry) => entry !== undefined))) {
    if (runner.sessions === undefined || !Object.hasOwn(runner.sessions, name)) problems.push(`Context.session "${name}" has no storageState file in playwrightRunner's sessions`);
  }
  return problems;
}

/** Runs one resolved case in a test body. Throws Playwright's own error on the first operation that does not hold, with the verdict line on it. */
async function runCase(
  testCase: CigeCase,
  fixtures: CigePlaywrightFixtures,
  config: CigeConfig<any>,
  runner: PlaywrightRunner,
  bindings: CigeBindings,
  register: TestType<any, any>,
  specFrame: string | undefined,
): Promise<void> {
  const plugins: readonly AnyPlugin[] = config.plugins ?? [];
  const agentContext = renderAgentContext(testCase, plugins);
  let current: CigeOp | undefined;
  try {
    const { session } = await startPlaywrightSession(testCase, fixtures, {
      bindings,
      ...(runner.judge === undefined ? {} : { judge: runner.judge }),
      ...(agentContext === undefined ? {} : { agentContext }),
      step: (title, body) => register.step(title, body),
    });
    await executePlan(testCase, session, { hooks: (config.hooks ?? {}) as never, plugins, onOp: (op) => (current = op) });
  } catch (cause) {
    const failure = failureOf(cause, current);
    const base = testCase.variant === undefined ? testCase.id : `${testCase.id}.${testCase.variant}`;
    const name = suffixRequested() ? `${base}.playwright` : base;
    const summary = path.join(config.outputDir ?? path.join('.e2e', 'cige'), `${fileSafe(name)}${SUMMARY_SUFFIX}`).split(path.sep).join('/');
    const line = verdictLine(testCase, classifyFailure(testCase, failure), summary);
    try {
      await fixtures.testInfo.attach(OUTCOME_ATTACHMENT, { body: JSON.stringify(failure), contentType: 'application/json' });
      fixtures.testInfo.annotations.push({ type: 'cige', description: line });
    } catch {
      // The test already ended (its timeout): the reporter reads the steps instead.
    }
    appendVerdict(cause, line);
    // A failure CIGE raised (a judgment, evidence, a guardrail) has no frame in the spec: point it at the case's cigeTest call.
    if (isCigeError(cause) && specFrame !== undefined && cause.stack !== undefined) {
      const [head, ...frames] = cause.stack.split('\n    at ');
      cause.stack = [head, specFrame, ...frames].join('\n    at ');
    }
    throw cause;
  }
}

/**
 * Registers one CIGE case, by id, as Playwright tests with its `act` and
 * `verify` steps bound to `bindings`. `config` is the CIGE config: its
 * `cases`, `root`, `hooks`, `environments`, `plugins`, and
 * `runners.playwright` (the judge, the saved sessions). Returns the case.
 */
export function cigeTest(config: CigeConfig<any>, id: string, bindings: CigeBindings, options: CigeTestOptions = {}): CigeCase {
  const call = callFrom(callerOf(cigeTest));
  const specFrame = specFrameOf(cigeTest);
  const root = rootOf(config.root);
  const runner = playwrightOf(config);
  const cases = loadCigeCases(config.cases ?? DEFAULT_CASES, { root });
  const testCase = cases.find((entry) => entry.id === id);
  if (testCase === undefined) {
    throw new CigeValidationError(`cigeTest(config, ${JSON.stringify(id)})`, [`no CIGE case has the id "${id}" under ${root}; known: ${cases.map((entry) => entry.id).join(', ') || 'none'}`]);
  }
  const problems = problemsOf(testCase, config, runner, bindings);
  if (problems.length > 0) throw new CigeValidationError(testCase.file ?? id, problems);
  const register = options.test ?? baseTest;
  const environments = config.environments;
  for (const resolved of expandVariants(testCase)) {
    const title = resolved.variant === undefined ? resolved.intent.statement : `${resolved.intent.statement} [${resolved.variant}]`;
    const tag = tagsOf(resolved.id, resolved.variant).map(playwrightTag);
    const environment = resolved.context.environment;
    const declared = environment !== undefined && environments !== undefined && Object.hasOwn(environments, environment) ? environments[environment] : undefined;
    const session = resolved.context.session;
    const storageState = session === undefined ? undefined : path.resolve(root, runner.sessions![session]!);
    // Playwright reads the fixtures a test uses from this parameter list: it must stay destructured.
    const body = async ({ page, context, request, browser, baseURL }: { page: CigePlaywrightFixtures['page']; context: CigePlaywrightFixtures['context']; request: CigePlaywrightFixtures['request']; browser: CigePlaywrightFixtures['browser']; baseURL: string | undefined }, testInfo: TestInfo) => {
      const site = declared?.baseURL ?? runner.baseURL ?? baseURL;
      await runCase(resolved, { page, context, request, browser, testInfo, baseURL: site }, config, runner, bindings, register, specFrame);
    };
    if (storageState === undefined) {
      call(register, title, { tag }, body);
    } else {
      call(register.describe, () => {
        register.use({ storageState });
        call(register, title, { tag }, body);
      });
    }
  }
  return testCase;
}
