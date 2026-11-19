/**
 * CIGE test cases on e2e: Context, Intent, Guardrails, and Execution as a
 * portable JSON file, registered as tests by `cigeSuite`, and summarized for
 * the agents that classify and repair them by the `cige()` reporter. The
 * `cige` command replays a case in its environment, resolves its refs,
 * and checks a change against the field rules. The standard:
 * https://www.amazon.science/publications/cige-an-agentic-ai-test-case-standard
 *
 * This entry is the 0.x API, bound to e2e as it always was. The runner-free
 * model is `e2e-cige/core`, the runner contract `e2e-cige/runner`, and the
 * adapters `e2e-cige/e2e` and `e2e-cige/vibium`.
 */

export {
  type CigeEnvironment,
  type CigeEnvironmentAction,
  type CigeRef,
  type CigeRefContext,
  type CigeRefResolver,
  type CigeRefs,
} from './core/config.ts';
export { defineCige, type CigeConfig, type CigePlugin, type CigeStepContext, type CigeStepRunner } from './adapters/e2e/types.ts';
export { cigeSuite, cigeTag, CIGE_TAG, type CigeSuiteOptions } from './adapters/e2e/suite.ts';
export type { CigeClassificationChange, CigeGuardrailViolation, CigeUseStep } from './core/plugins.ts';
export type { CigeExtensions } from './core/extensions.ts';
export type { CigeGap, CigeGapKind } from './core/check.ts';
export { expandVariants } from './core/variants.ts';
export { writeRefs, type CigeRefsIndex } from './core/refs.ts';
export { diffCases, type CigeChange, type CigeChangeKind } from './core/diff.ts';
export { runCige, type CigeHook, type CigeHooks, type RunCigeOptions } from './adapters/e2e/run.ts';
export { loadCigeCases, loadCigeFile, type CigeRoot, type LoadOptions } from './core/load.ts';
export { cige, type CigeReporterOptions, type CigeRunSummary } from './adapters/e2e/reporter.ts';
export { classifyResult } from './adapters/e2e/report.ts';
export type { CigeClassification, CigeFailureType, CigePhase } from './core/classify.ts';
export { createGuardrailMonitor } from './adapters/e2e/guardrails.ts';
export { actInstruction, intentAssertion, renderAgentContext } from './core/render.ts';
export { CigeError } from './core/errors.ts';
export { e2eRunner } from './adapters/e2e/runner.ts';
export {
  CigeValidationError,
  parseCige,
  type CigeCase,
  type CigeContext,
  type CigeEvidence,
  type CigeExecutionStep,
  type CigeGuardrail,
  type CigeIntent,
  type CigePrecondition,
  type CigeTestCase,
  type CigeVariant,
} from './core/schema.ts';
