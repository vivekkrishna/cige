/**
 * `e2e-cige/e2e`: CIGE on e2e. `cigeSuite` registers the cases as e2e
 * tests, the `cige()` reporter writes their run summaries, and `e2eRunner`
 * names e2e as a runner in the CIGE config.
 */

export { defineCige, type CigeConfig, type CigePlugin, type CigeStepContext, type CigeStepRunner } from './types.ts';
export { cigeSuite, cigeTag, CIGE_TAG, type CigeSuiteOptions } from './suite.ts';
export { runCige, missingHooks, missingStepKinds, type CigeHook, type CigeHooks, type RunCigeOptions } from './run.ts';
export { e2eSession } from './session.ts';
export { cige, RUNNER_SELECTION_ENV, RUNNER_SUFFIX_ENV, type CigeReporterOptions, type CigeRunSummary } from './reporter.ts';
export { attemptsOf, classifyResult, outcomeOf } from './report.ts';
export { createGuardrailMonitor, violatedGuardrail } from './guardrails.ts';
export { e2eRunner, E2E_CAPABILITIES, type E2eRunner, type E2eRunnerOptions } from './runner.ts';
