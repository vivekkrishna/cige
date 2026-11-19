/**
 * `CigeError`: a failure with a code, thrown by hooks and step kinds that
 * run on any runner, and by owned-mode adapters for the operations they run.
 * The codes are e2e's agent codes where the meaning is the same, so a hook
 * written for e2e (`throw new AgentError('ENVIRONMENT_UNAVAILABLE', ...)`)
 * and one written for every runner (`throw new CigeError(...)`) read back
 * the same. The e2e adapter turns a `CigeError` into an `AgentError`.
 */

import type { CigeOp } from './plan.ts';
import type { CigeSignal, CigeSignalKind } from './signals.ts';

/** The codes a hook or step kind is documented to throw; an adapter may use its own beside them. */
export type CigeErrorCode =
  | 'ENVIRONMENT_UNAVAILABLE'
  | 'TEST_SETUP_FAILED'
  | 'ASSERTION_FAILED'
  | 'ASSERTION_INCONCLUSIVE'
  | 'ACTION_FAILED'
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'POLICY_DENIED'
  | (string & {});

const CODE_SIGNALS: ReadonlyMap<string, CigeSignalKind> = new Map<string, CigeSignalKind>([
  ['ENVIRONMENT_UNAVAILABLE', 'env.unavailable'],
  ['APP_UNREACHABLE', 'env.unavailable'],
  ['SEED_DATA_MISSING', 'env.unavailable'],
  ['AUTH_FAILED', 'env.unavailable'],
  ['TEST_SETUP_FAILED', 'env.config'],
  ['PROVIDER_ERROR', 'provider.error'],
  ['ASSERTION_FAILED', 'assert.false'],
  ['ASSERTION_INCONCLUSIVE', 'assert.inconclusive'],
  ['ACTION_FAILED', 'step.action-failed'],
  ['LOCATOR_NOT_FOUND', 'step.target-missing'],
  ['LOCATOR_AMBIGUOUS', 'step.target-ambiguous'],
]);

/**
 * The signals a code carries where it was thrown. A plugin's step that
 * failed without its own verdict is `step.plugin-failed`, on every runner.
 */
export function signalsForCode(code: string, op?: CigeOp): CigeSignal[] {
  if (op?.kind === 'use' && (code === 'ACTION_FAILED' || code === 'TEST_SETUP_FAILED')) return [{ kind: 'step.plugin-failed' }];
  if (op?.kind === 'act' && code === 'ASSERTION_FAILED') return [{ kind: 'step.goal-unreached' }];
  const kind = CODE_SIGNALS.get(code);
  return kind === undefined ? [] : [{ kind }];
}

export interface CigeErrorOptions {
  readonly cause?: unknown;
  /** The neutral signals the failure carries; default the code's own. */
  readonly signals?: readonly CigeSignal[];
  /** What the runner saw, for the run summary. */
  readonly evidence?: readonly { readonly summary: string }[];
  /** The runner's native result, for plugins' `classify`. */
  readonly native?: unknown;
}

export class CigeError extends Error {
  readonly code: CigeErrorCode;
  readonly signals: readonly CigeSignal[];
  readonly evidence: readonly { readonly summary: string }[];
  readonly native: unknown;

  constructor(code: CigeErrorCode, message: string, options: CigeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CigeError';
    this.code = code;
    this.signals = options.signals ?? signalsForCode(code);
    this.evidence = options.evidence ?? [];
    this.native = options.native;
  }
}

export function isCigeError(value: unknown): value is CigeError {
  return value instanceof CigeError;
}

/**
 * An error that carries a code of its own, such as e2e's `AgentError`,
 * thrown into a runner that is not e2e: read by its `code`.
 */
export function codedError(value: unknown): { readonly code: string; readonly message: string } | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value) || typeof value.code !== 'string') return undefined;
  if (!/^[A-Z][A-Z0-9_]+$/.test(value.code)) return undefined;
  return { code: value.code, message: value instanceof Error ? value.message : String(value.code) };
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
