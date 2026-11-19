/**
 * The plan: one resolved case as the ordered, runner-neutral operations every
 * runner makes, in the order the standard reveals them. Preconditions first,
 * then `Context.open`, so the page loads the state the hooks seeded, then each
 * Execution entry, then every piece of evidence, then the Intent itself. Each
 * operation keeps the id a run summary names it by (an Execution id, an
 * evidence id, or `intent`), so `failedStep` reads the same whichever runner
 * ran it.
 */

import { actInstruction, intentAssertion } from './render.ts';
import type { CigeCase, CigeExecutionStep } from './schema.ts';

/** Where in the case an operation sits. */
export type CigePhase = 'precondition' | 'execution' | 'evidence' | 'intent';

export type CigeUseStep = Extract<CigeExecutionStep, { readonly kind: 'use' }>;
export type CigeActStep = Extract<CigeExecutionStep, { readonly kind: 'act' }>;

export type CigeOp =
  | { readonly kind: 'precondition'; readonly phase: 'precondition'; readonly hook: string }
  | { readonly kind: 'open'; readonly phase: 'precondition'; readonly url: string }
  | {
      readonly kind: 'act';
      readonly phase: 'execution';
      readonly id: string;
      /** The step's goal as written, placeholders unfilled. */
      readonly text: string;
      /** The goal with the guardrail block appended: what the acting agent reads. */
      readonly instruction: string;
      readonly params?: Readonly<Record<string, unknown>>;
      readonly step: CigeActStep;
    }
  | { readonly kind: 'verify'; readonly phase: 'execution' | 'evidence'; readonly id: string; readonly text: string; readonly vision?: boolean }
  | { readonly kind: 'use'; readonly phase: 'execution'; readonly id: string; readonly step: CigeUseStep }
  | { readonly kind: 'evidence'; readonly phase: 'evidence'; readonly id: string; readonly hook: string }
  | { readonly kind: 'judge'; readonly phase: 'intent'; readonly id: 'intent'; readonly text: string };

/** The operations one resolved case makes, in order. */
export function planCase(testCase: CigeCase): CigeOp[] {
  const ops: CigeOp[] = [];
  for (const precondition of testCase.context.preconditions) {
    if (precondition.kind === 'hook') ops.push({ kind: 'precondition', phase: 'precondition', hook: precondition.hook });
  }
  if (testCase.context.open !== undefined) ops.push({ kind: 'open', phase: 'precondition', url: testCase.context.open });
  for (const step of testCase.execution) {
    if (step.kind === 'verify') {
      ops.push({ kind: 'verify', phase: 'execution', id: step.id, text: step.text, ...(step.vision === undefined ? {} : { vision: step.vision }) });
    } else if (step.kind === 'use') {
      ops.push({ kind: 'use', phase: 'execution', id: step.id, step });
    } else {
      ops.push({
        kind: 'act',
        phase: 'execution',
        id: step.id,
        text: step.text,
        instruction: actInstruction(testCase, step),
        ...(step.params === undefined ? {} : { params: step.params }),
        step,
      });
    }
  }
  for (const item of testCase.intent.evidence) {
    if (item.kind === 'assert') ops.push({ kind: 'verify', phase: 'evidence', id: item.id, text: item.text, ...(item.vision === undefined ? {} : { vision: item.vision }) });
    else ops.push({ kind: 'evidence', phase: 'evidence', id: item.id, hook: item.hook });
  }
  if (testCase.intent.judge) ops.push({ kind: 'judge', phase: 'intent', id: 'intent', text: intentAssertion(testCase) });
  return ops;
}

/** The id a run summary names an operation by, when it has one: preconditions and `open` have none. */
export function opId(op: CigeOp): string | undefined {
  return op.kind === 'precondition' || op.kind === 'open' ? undefined : op.id;
}
