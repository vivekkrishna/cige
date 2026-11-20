/**
 * `e2e-cige/core`: the CIGE model with no runner in it. The case format and
 * its loader, variants, refs, the field rules `diff` enforces, readiness,
 * what reaches the model, the runner-neutral plan, signals, classification,
 * and the summary writer. It imports no runner: a Vibium-only project uses
 * it without e2e installed.
 */

export {
  defineCige,
  fillRef,
  DEFAULT_CASES,
  type CigeConfig,
  type CigeEnvironment,
  type CigeEnvironmentAction,
  type CigeRef,
  type CigeRefContext,
  type CigeRefResolver,
  type CigeRefs,
} from './config.ts';
export { CIGE_TAG, cigeGrep, cigeTag, playwrightTag, tagsOf } from './tags.ts';
export { denyRequests, type DenyRequest } from './deny-requests.ts';
export { hostedEnv, RUNNER_SELECTION_ENV, RUNNER_SUFFIX_ENV, selectionsFor, suffixRequested } from './hosted.ts';
export type {
  AnyPlugin,
  CigeActionEvent,
  CigeClassificationChange,
  CigeGuardrailViolation,
  CigePlugin,
  CigeStepContext,
  CigeStepRunner,
  CigeUseStep,
} from './plugins.ts';
export { missingStepKinds, servesRunner, stepRunnerOf } from './plugins.ts';
export type { CigeExtensions } from './extensions.ts';
export { readinessGaps, type CigeGap, type CigeGapKind } from './check.ts';
export { expandVariants, caseForVariant } from './variants.ts';
export { writeRefs, type CigeRefsIndex } from './refs.ts';
export { diffCases, type CigeChange, type CigeChangeKind } from './diff.ts';
export { loadCigeCases, loadCigeFile, type CigeRoot, type LoadOptions } from './load.ts';
export { classify, type CigeClassification, type CigeFailureType, type CigePhase } from './classify.ts';
export { actInstruction, intentAssertion, renderAgentContext } from './render.ts';
export { planCase, opId, type CigeOp } from './plan.ts';
export type { CigeFailure, CigeOutcome, CigeSignal, CigeSignalKind } from './signals.ts';
export { CigeError, isCigeError, signalsForCode, type CigeErrorCode, type CigeErrorOptions } from './errors.ts';
export { executePlan, missingHooks, type CigeHook, type CigeHookInfo, type CigeHooks, type ExecuteOptions } from './execute.ts';
export type { CigeRunRecord } from './record.ts';
export { summarize, writeSummaries, type CigeRunSummary, type CigeSummaryCounts } from './summary.ts';
export { defaultRunnerName, parseRunnerList, PLAYWRIGHT_PACKAGE } from './select.ts';
export { AUTO, baseName, DEFAULT_PREFER, lastRunner, readHistory, routeCase, selectionOf, type RouteCandidate, type RouteConsidered, type RouteDecision, type RunHistory } from './route.ts';
export type {
  CigeActOp,
  CigeAvailability,
  CigeCapabilities,
  CigeJudgeOp,
  CigeLaunch,
  CigeLaunchRequest,
  CigeReadinessContext,
  CigeRejudgeInput,
  CigeResolvedEnvironment,
  CigeRunner,
  CigeRunnerReadiness,
  CigeRunnerSelection,
  CigeSession,
  CigeSessionArtifacts,
  CigeStartContext,
  CigeVerifyOp,
} from './contract.ts';
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
} from './schema.ts';
