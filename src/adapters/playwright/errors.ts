/**
 * Playwright's errors as CIGE failures. A binding is plain Playwright code,
 * so what went wrong is read from the error it threw, where it threw it:
 *
 * | Playwright says | Code | Signal |
 * | --- | --- | --- |
 * | `net::ERR_*`, `NS_ERROR_*`, `ECONNREFUSED`, a closed browser | `ENVIRONMENT_UNAVAILABLE` | `env.unavailable` |
 * | `strict mode violation` | `LOCATOR_AMBIGUOUS` | `step.target-ambiguous` |
 * | An `expect` that found no element | `LOCATOR_NOT_FOUND` | `step.target-missing` |
 * | Any other failed `expect` | `ASSERTION_FAILED` | `assert.false`; `step.goal-unreached` in an `act` step |
 * | An action's timeout on a locator that never resolved | `LOCATOR_NOT_FOUND` | `step.target-missing` |
 * | An action's timeout, or refusal, on one that did (hidden, disabled, covered) | `ACTION_FAILED` | `step.action-failed` |
 * | A navigation that timed out | `ENVIRONMENT_UNAVAILABLE` | `env.unavailable` |
 * | Any other timeout | `PLAYWRIGHT_TIMEOUT` | `step.limit` |
 * | Anything else | `PLAYWRIGHT_ERROR` | none: the classifying agent reads the message |
 *
 * The routing from signals to a failure type stays in `core/classify.ts`.
 */

import { CigeError, codedError, isCigeError, messageOf, signalsForCode } from '../../core/errors.ts';
import type { CigeOp } from '../../core/plan.ts';
import type { CigeSignal } from '../../core/signals.ts';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** A Playwright error's message without its terminal colors. */
export function plainMessage(cause: unknown): string {
  return messageOf(cause).replace(ANSI, '');
}

const NETWORK = /net::ERR_|NS_ERROR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/;
const CLOSED = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;
const NOT_FOUND = /element\(s\) not found/;
const RESOLVED = /locator resolved to/;
const WAITING = /waiting for (locator|getBy|selector|frameLocator)/i;
const NAVIGATION = /page\.(goto|reload|goBack|goForward|waitForURL|waitForNavigation)\b|navigating to/;
const REFUSED_ACTION = /element is not (attached|visible|enabled|editable|stable)|intercepts pointer events|outside of the viewport|Element is not an? /i;

/** Whether an error is a failed `expect` matcher. */
export function isExpectFailure(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'matcherResult' in cause;
}

function failure(code: string, message: string, cause: unknown, op: CigeOp | undefined, signals?: CigeSignal[]): CigeError {
  return new CigeError(code, message, { cause, signals: signals ?? signalsForCode(code, op) });
}

/**
 * What a throw out of Playwright code means, given the operation it came
 * from: a `CigeError` keeps its own signals, an error with a code (an e2e
 * `AgentError` a shared hook threw) keeps its code.
 */
export function playwrightFailure(cause: unknown, op: CigeOp | undefined): CigeError {
  if (isCigeError(cause)) return cause;
  const message = plainMessage(cause);
  const name = cause instanceof Error ? cause.name : '';
  if (NETWORK.test(message) || CLOSED.test(message)) return failure('ENVIRONMENT_UNAVAILABLE', message, cause, op);
  const coded = codedError(cause);
  if (coded !== undefined) return failure(coded.code, coded.message, cause, op);
  if (/strict mode violation/.test(message)) return failure('LOCATOR_AMBIGUOUS', message, cause, op);
  if (isExpectFailure(cause)) return failure(NOT_FOUND.test(message) ? 'LOCATOR_NOT_FOUND' : 'ASSERTION_FAILED', message, cause, op);
  if (name === 'TimeoutError') {
    if (RESOLVED.test(message)) return failure('ACTION_FAILED', message, cause, op);
    if (WAITING.test(message)) return failure('LOCATOR_NOT_FOUND', message, cause, op);
    if (NAVIGATION.test(message)) return failure('ENVIRONMENT_UNAVAILABLE', message, cause, op);
    return failure('PLAYWRIGHT_TIMEOUT', message, cause, op, [{ kind: 'step.limit' }]);
  }
  if (REFUSED_ACTION.test(message)) return failure('ACTION_FAILED', message, cause, op);
  return failure('PLAYWRIGHT_ERROR', message, cause, op, []);
}
