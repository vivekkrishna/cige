/**
 * Vibium's native outcomes as CIGE failures. `run` and `check` return a
 * structured status and reason rather than throwing, so each is read here
 * into a code and the neutral signals; a throw from either means Vibium
 * itself couldn't run the operation (the browser, the connection, the
 * model provider), never a verdict on the app.
 */

import { CigeError } from '../../core/errors.ts';
import type { CigeGuardrail } from '../../core/schema.ts';
import type { CigeSignal } from '../../core/signals.ts';
import type { VibiumCheckResult, VibiumRunResult } from './types.ts';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The guardrail an agent's own account cites by id, when it names one. */
function citedGuardrail(text: string, guardrails: readonly CigeGuardrail[]): string | undefined {
  return guardrails.find((rule) => new RegExp(`(^|[^A-Za-z0-9._-])${escapeRegExp(rule.id)}($|[^A-Za-z0-9._-])`).test(text))?.id;
}

const evidenceOf = (result: VibiumRunResult | VibiumCheckResult) => result.evidence.map((item) => ({ summary: item.summary }));

/** The failure a `run` that did not complete is, or undefined when it completed. */
export function runFailure(result: VibiumRunResult, guardrails: readonly CigeGuardrail[]): CigeError | undefined {
  if (result.status === 'completed') return undefined;
  const options = (signals: CigeSignal[]) => ({ signals, evidence: evidenceOf(result), native: result });
  switch (result.reason) {
    case 'action_limit':
      return new CigeError('RUN_ACTION_LIMIT', `page.run spent its action budget: ${result.summary}`, options([{ kind: 'step.limit' }]));
    case 'missing_information':
      return new CigeError('RUN_MISSING_INFORMATION', `page.run stopped for information the case doesn't give: ${result.summary}`, options([{ kind: 'step.missing-information' }]));
    case 'safety_stop': {
      // The agent stopped itself: one that cites a guardrail refused a forbidden step.
      const cited = citedGuardrail(result.summary, guardrails);
      return new CigeError('RUN_SAFETY_STOP', `page.run stopped for safety: ${result.summary}`, options([cited === undefined ? { kind: 'guardrail.refused' } : { kind: 'guardrail.refused', detail: cited }]));
    }
    default:
      return new CigeError('RUN_NOT_COMPLETED', `page.run did not reach the goal: ${result.summary}`, options([{ kind: 'step.goal-unreached' }]));
  }
}

/** The failure a `check` that did not pass is, or undefined when it passed. */
export function checkFailure(result: VibiumCheckResult, label: string): CigeError | undefined {
  if (result.status === 'passed') return undefined;
  const native = { evidence: evidenceOf(result), native: result };
  if (result.status === 'failed') return new CigeError('CHECK_FAILED', `${label} was judged false: ${result.summary}`, { ...native, signals: [{ kind: 'assert.false' }] });
  const signals: CigeSignal[] = [{ kind: 'assert.inconclusive' }];
  if (result.reason === 'archive_missing_evidence') signals.push({ kind: 'evidence.archive-missing' });
  return new CigeError('CHECK_INCONCLUSIVE', `${label} could not be judged${result.reason === undefined ? '' : ` (${result.reason})`}: ${result.summary}`, { ...native, signals });
}

/** A throw from Vibium itself, as a failure: the runner, not the app. */
export function runnerFailure(cause: unknown, what: string): CigeError {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${what} failed in Vibium: ${message}`;
  if (name === 'ConnectionError' || name === 'BrowserCrashedError') return new CigeError('ENVIRONMENT_UNAVAILABLE', text, { cause });
  if (/api[ _-]?key|provider|unauthori[sz]ed|\b40[13]\b|\b429\b|rate.?limit|quota/i.test(message)) return new CigeError('PROVIDER_ERROR', text, { cause, signals: [{ kind: 'provider.error' }] });
  if (name === 'TimeoutError') return new CigeError('VIBIUM_TIMEOUT', text, { cause, signals: [{ kind: 'step.limit' }] });
  // Unknown: no signal, so the classifier leaves the type to the agent reading the message.
  return new CigeError('VIBIUM_ERROR', text, { cause, signals: [] });
}
