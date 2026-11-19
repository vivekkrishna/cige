/**
 * `e2e-cige/runner`: what a runner adapter is built from. The contract an
 * adapter implements, the one loop every runner runs a case through, the
 * neutral signals it reports, and the conformance kit that proves an
 * adapter routes failures the way every other runner does.
 */

export type {
  CigeActOp,
  CigeCapabilities,
  CigeJudgeOp,
  CigeRejudgeInput,
  CigeResolvedEnvironment,
  CigeRunner,
  CigeSession,
  CigeSessionArtifacts,
  CigeStartContext,
  CigeThrowSite,
  CigeVerifyOp,
} from '../core/contract.ts';
export { executePlan, type CigeHook, type CigeHookInfo, type CigeHooks, type ExecuteOptions } from '../core/execute.ts';
export { CigeError, codedError, isCigeError, signalsForCode, type CigeErrorCode, type CigeErrorOptions } from '../core/errors.ts';
export { planCase, opId, type CigeOp, type CigePhase } from '../core/plan.ts';
export { classify } from '../core/classify.ts';
export type { CigeFailure, CigeOutcome, CigeSignal, CigeSignalKind } from '../core/signals.ts';
export type { CigeRunRecord } from '../core/record.ts';
export {
  checkConformance,
  conformanceHooks,
  conformancePlugin,
  CONFORMANCE_MARKERS,
  CONFORMANCE_SCENARIOS,
  type ConformanceExpectation,
  type ConformanceReport,
  type ConformanceScenario,
} from './conformance.ts';
