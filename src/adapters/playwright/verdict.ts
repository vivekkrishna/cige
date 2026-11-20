/**
 * What a failed CIGE test leaves in Playwright's own result, for the agent
 * that reads the failure before any summary: the neutral failure as a
 * `cige-outcome` attachment (the reporter's source of truth), and one line
 * appended to the error, never replacing it, that says what kind of failure
 * this first looks like and what a repair may touch. Playwright's healer
 * reads the error; the line is the rule it would otherwise not know.
 */

import { classify, type CigeClassification } from '../../core/classify.ts';
import type { CigeOp } from '../../core/plan.ts';
import { opId } from '../../core/plan.ts';
import type { CigeCase } from '../../core/schema.ts';
import type { CigeFailure } from '../../core/signals.ts';
import { plainMessage, playwrightFailure } from './errors.ts';

/** The attachment a failed CIGE test carries: the JSON of its `CigeFailure`. */
export const OUTCOME_ATTACHMENT = 'cige-outcome';

/** A failure message as a summary keeps it: plain text, at most this long. */
const MAX_MESSAGE = 2000;

/** The failure a throw out of the plan is, given the operation it came from. */
export function failureOf(cause: unknown, op: CigeOp | undefined): CigeFailure {
  const error = playwrightFailure(cause, op);
  const message = plainMessage(error);
  const id = op === undefined ? undefined : opId(op);
  return {
    phase: op?.phase ?? 'precondition',
    ...(id === undefined ? {} : { failedStep: id }),
    signals: error.signals,
    code: error.code,
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message,
  };
}

/** The first classification of a failure, as the reporter will make it before any plugin adjusts it. */
export function classifyFailure(testCase: CigeCase, failure: CigeFailure): CigeClassification {
  return classify(testCase, { result: 'fail', status: 'failed', failure });
}

/** The line a failed test's error ends with: the failure type, and what a repair may and may not touch. */
export function verdictLine(testCase: CigeCase, classification: CigeClassification, summary: string): string {
  const where = classification.failedStep === undefined ? (classification.phase ?? 'setup') : `step ${classification.failedStep}`;
  const head = `CIGE ${testCase.id}${testCase.variant === undefined ? '' : `/${testCase.variant}`} failed at ${where}`;
  const violated = classification.signals.find((signal) => signal.startsWith('guardrail-violation:'))?.slice('guardrail-violation:'.length);
  if (violated !== undefined) {
    return `${head}: guardrail ${violated} blocked a forbidden request. Do not loosen the guardrail or route around it; check the spec for whether the flow now needs it. Summary: ${summary}`;
  }
  switch (classification.failureType) {
    case 'outdated-test-logic':
      return `${head}: outdated-test-logic. The flow changed under this step: repairing its binding in the .cige.spec.ts file is allowed; leave the case's Intent, Guardrails, evidence, and cige.config.ts as they are. Summary: ${summary}`;
    case 'product-defect':
      return `${head}: product-defect. The app contradicts the Intent: do not change this test, its expected values, or mark it fixme; report the defect. Summary: ${summary}`;
    case 'infrastructure':
      return `${head}: infrastructure. The environment was not ready: restore it and rerun; do not change this test. Summary: ${summary}`;
    default:
      return `${head}: not classified (${classification.signals.filter((signal) => !signal.startsWith('status:') && !signal.startsWith('phase:')).join(', ') || 'no signal'}). Classify it before changing anything. Summary: ${summary}`;
  }
}

/** Appends the line to the error Playwright will report, keeping its message and stack as they were. */
export function appendVerdict(cause: unknown, line: string): void {
  if (!(cause instanceof Error)) return;
  try {
    cause.message = `${cause.message}\n\n${line}`;
  } catch {
    // A frozen error keeps its message; the annotation and the attachment still carry the line.
  }
}
