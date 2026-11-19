/**
 * Neutral signals: what a runner observed about one failure, in words no
 * runner owns. Each adapter translates its native outcome (an e2e error code
 * and step status, a Vibium `run` or `check` result) into these, and one
 * classifier (`classify.ts`) maps them to a failure type and to the signal
 * strings a run summary has always carried. The strings are the public
 * contract the `cige` skill reads; these kinds are the internal one.
 */

import type { CigePhase } from './plan.ts';

export type CigeSignalKind =
  /** The environment, the app, a credential, or seed data was not there. */
  | 'env.unavailable'
  /** The run was misconfigured: a setup the case needs is missing. */
  | 'env.config'
  /** The model provider failed: a key, a quota, an outage. */
  | 'provider.error'
  /** A step's target is gone (e2e LOCATOR_NOT_FOUND). */
  | 'step.target-missing'
  /** A step's target matches more than one element (e2e LOCATOR_AMBIGUOUS). */
  | 'step.target-ambiguous'
  /** A step's action failed on its target (e2e ACTION_FAILED). */
  | 'step.action-failed'
  /** A recorded path no longer replays (e2e REPLAY_STALE). */
  | 'step.stale-replay'
  /** An act step's goal could not be reached. */
  | 'step.goal-unreached'
  /** A spent budget, the clock, a model that never concluded, a blocked step. */
  | 'step.limit'
  /** The agent stopped for information the case didn't give it. */
  | 'step.missing-information'
  /** A step ran before any app was open. */
  | 'step.app-not-open'
  /** A plugin's `use` step threw a plain error. */
  | 'step.plugin-failed'
  /** The runner enforced a guardrail: a deny rule or a blocked request matched. `detail` is the guardrail id. */
  | 'guardrail.violated'
  /** The agent stopped itself, citing a guardrail. `detail` is the guardrail id, when it named one. */
  | 'guardrail.refused'
  /** A check said no: a verify, a piece of evidence, the Intent. */
  | 'assert.false'
  /** A check couldn't reach a verdict. */
  | 'assert.inconclusive'
  /** An archive judge found the recording lacked what it needed to decide. */
  | 'evidence.archive-missing'
  /** The run was stopped before the test finished (a timeout). */
  | 'run.stopped';

export interface CigeSignal {
  readonly kind: CigeSignalKind;
  /** A guardrail id, for the guardrail kinds. */
  readonly detail?: string;
}

/** One failure, as an adapter observed it. */
export interface CigeFailure {
  readonly phase: CigePhase;
  /** The Execution id, evidence id, or `intent` the failure landed in. */
  readonly failedStep?: string;
  readonly signals: readonly CigeSignal[];
  /** The runner's own code for it, as it reported it. */
  readonly code?: string;
  readonly message?: string;
}

/** One result, as an adapter observed it: what the classifier reads. */
export interface CigeOutcome {
  readonly result: 'pass' | 'fail' | 'skipped' | 'interrupted';
  /** The runner's own word for the status, read back as `status:<word>`. */
  readonly status: string;
  /** Set on a failure that reached an attempt. */
  readonly failure?: CigeFailure;
}

/** The step signals that mean the path, not the product, changed. */
export const PATH_SIGNALS: ReadonlySet<CigeSignalKind> = new Set(['step.target-missing', 'step.target-ambiguous', 'step.action-failed', 'step.stale-replay']);

/** The signals that mean execution never fairly reached the system under test. */
export const SETUP_SIGNALS: ReadonlySet<CigeSignalKind> = new Set(['env.unavailable', 'env.config', 'provider.error']);

export function hasSignal(signals: readonly CigeSignal[], kind: CigeSignalKind): boolean {
  return signals.some((signal) => signal.kind === kind);
}

export function signalOf(signals: readonly CigeSignal[], kind: CigeSignalKind): CigeSignal | undefined {
  return signals.find((signal) => signal.kind === kind);
}
