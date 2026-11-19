/**
 * A first, deterministic classification of one CIGE result from the neutral
 * signals its runner's adapter observed. It is a hint for the classifying
 * agent, never the verdict: every summary says `confidence: "heuristic"`,
 * names the raw signals it read, and leaves `failureType` out whenever the
 * signals alone cannot tell the cases apart (a guardrail violation, an
 * inconclusive judgment). The `cige` skill's classify step confirms it
 * against `specRef`, `buildRef`, and `expectedRef` before any repair, and
 * decides whether a pass was a false positive; this module never calls one.
 *
 * This is the one place the standard's routing lives: every runner's
 * failures reach a failure type through this function.
 */

import type { CigePhase } from './plan.ts';
import type { CigeCase } from './schema.ts';
import { hasSignal, PATH_SIGNALS, SETUP_SIGNALS, signalOf, type CigeOutcome } from './signals.ts';

export type { CigePhase } from './plan.ts';

/**
 * The failure types a run summary can carry. The standard's fourth route, a
 * false positive, is a pass that should not have counted; only the
 * classifying agent can call one, from the `screen-only-evidence` signal and
 * the evidence, so it is never set here.
 */
export type CigeFailureType = 'infrastructure' | 'outdated-test-logic' | 'product-defect';

export interface CigeClassification {
  readonly result: 'pass' | 'fail' | 'skipped' | 'interrupted';
  /** The Execution step, evidence item, or `intent` the failure landed in. */
  readonly failedStep?: string;
  readonly phase?: CigePhase;
  /** Absent on a pass, and whenever the signals don't decide it. */
  readonly failureType?: CigeFailureType;
  readonly errorCode?: string;
  readonly message?: string;
  /** What the classification read, e.g. `code:REPLAY_STALE`, `guardrail-violation:g2`, `screen-only-evidence`. */
  readonly signals: readonly string[];
}

/** Classifies one outcome of a resolved case. */
export function classify(testCase: CigeCase, outcome: CigeOutcome): CigeClassification {
  const status = `status:${outcome.status}`;
  if (outcome.result === 'skipped') return { result: 'skipped', signals: [status] };
  // Stopped before a verdict: never counted as failed, so never triaged.
  if (outcome.result === 'interrupted') return { result: 'interrupted', signals: [status] };
  if (outcome.result === 'pass') {
    const signals = [status];
    if (!testCase.intent.evidence.some((item) => item.kind === 'hook')) signals.push('screen-only-evidence');
    return { result: 'pass', signals };
  }
  const failure = outcome.failure;
  if (failure === undefined) return { result: 'fail', signals: [status, 'no-attempt'] };

  const signals: string[] = [status, `phase:${failure.phase}`];
  if (failure.code !== undefined) signals.push(`code:${failure.code}`);
  const base = {
    result: 'fail' as const,
    phase: failure.phase,
    ...(failure.failedStep === undefined ? {} : { failedStep: failure.failedStep }),
    ...(failure.code === undefined ? {} : { errorCode: failure.code }),
    ...(failure.message === undefined ? {} : { message: failure.message }),
  };
  const observed = failure.signals;

  // The runner stopped a forbidden path: a changed flow that now routes
  // through it, or a product that forces it. Only the spec can tell.
  const violated = signalOf(observed, 'guardrail.violated');
  if (violated !== undefined) return { ...base, signals: [...signals, `guardrail-violation:${violated.detail ?? 'unknown'}`] };
  // The agent read a guardrail and stopped before acting: the step needs a
  // forbidden action, which routes like a violation.
  const refused = signalOf(observed, 'guardrail.refused');
  if (refused !== undefined) return { ...base, signals: [...signals, refused.detail === undefined ? 'guardrail-refused' : `guardrail-refused:${refused.detail}`] };
  // A plugin's step threw a plain error: its own failure, not a changed flow, so the classifier reads its message.
  if (hasSignal(observed, 'step.plugin-failed')) return { ...base, signals: [...signals, `plugin-step-failed:${failure.failedStep ?? 'unknown'}`] };

  // An act step that couldn't reach its goal: a changed flow causes it as often as a defect.
  if (hasSignal(observed, 'step.goal-unreached')) signals.push('goal-unreachable');
  const failureType = ((): CigeFailureType | undefined => {
    if (failure.phase === 'precondition') return 'infrastructure';
    if (failure.phase === 'execution' && observed.some((signal) => PATH_SIGNALS.has(signal.kind))) return 'outdated-test-logic';
    if (observed.some((signal) => SETUP_SIGNALS.has(signal.kind))) return 'infrastructure';
    if (hasSignal(observed, 'assert.false')) return 'product-defect';
    return undefined;
  })();
  if (hasSignal(observed, 'assert.inconclusive')) signals.push('inconclusive-evidence');
  if (hasSignal(observed, 'evidence.archive-missing')) signals.push('archive-missing-evidence');
  if (hasSignal(observed, 'step.limit')) signals.push('automation-limit');
  if (hasSignal(observed, 'step.missing-information')) signals.push('missing-information');
  if (hasSignal(observed, 'run.stopped')) signals.push('run-stopped');
  return { ...base, ...(failureType === undefined ? {} : { failureType }), signals };
}
