/**
 * The adapter conformance kit: one set of scenarios every runner adapter
 * runs, each a case and the run summary it must produce. A harness scripts
 * how its runner natively reports each scenario (an e2e executor that ends a
 * step `LOCATOR_NOT_FOUND`, a Vibium `run` that ends `not_completed`), runs
 * the cases through its adapter, and hands the summaries back; the kit says
 * where they differ from what the standard routes. A renamed button is
 * outdated test logic and a broken total a product defect on every runner,
 * or the classification can't be trusted on any of them.
 *
 * Each scenario's steps carry a marker phrase a harness keys its script on.
 * A scenario a runner can't natively produce (Vibium has no recorded path to
 * go stale) is listed as unsupported with the reason, never faked.
 */

import { CigeError } from '../core/errors.ts';
import type { CigeHooks } from '../core/execute.ts';
import type { CigePlugin } from '../core/plugins.ts';
import type { CigeTestCase } from '../core/schema.ts';
import type { CigeRunSummary } from '../core/summary.ts';

/** What a scenario's summary must hold. `failureType: null` means it must be absent. */
export interface ConformanceExpectation {
  readonly result: CigeRunSummary['result'];
  readonly failedStep?: string;
  readonly failureType?: CigeRunSummary['failureType'] | null;
  /** Signals the summary must carry, among others. */
  readonly signals?: readonly string[];
}

export interface ConformanceScenario {
  /** The case id, and what the summary is named after. */
  readonly id: string;
  /** What the runner must natively report, for the harness's script. */
  readonly native: string;
  readonly case: CigeTestCase;
  readonly expect: ConformanceExpectation;
}

/** The marker phrases a harness's script keys on, by scenario. */
export const CONFORMANCE_MARKERS = {
  staleTarget: 'press the old Checkout button',
  brokenTotal: 'discount',
  forbiddenRequest: 'refund the order',
  refusal: 'delete the todo',
  unreachable: 'open the Billing tab',
  budget: 'drag the card',
  missingInformation: "look up the customer's account number",
} as const;

/** The guardrail the violation scenario breaks: both kinds of rule, so a runner of either kind enforces it. */
const NO_REFUND = {
  id: 'no-refund',
  rule: 'Never refund an order',
  deny: { actions: ['tool:refund'] },
  'x-deny-requests': ['POST **/refund*'],
};

export const CONFORMANCE_SCENARIOS: readonly ConformanceScenario[] = [
  {
    id: 'pass',
    native: 'every step and check passes',
    case: {
      id: 'pass',
      Context: { system: 'Shop' },
      Intent: { statement: 'A shopper can place an order', evidence: [{ id: 'order-record', hook: 'orderExists' }] },
      Guardrails: ['Use only the test card'],
      Execution: [{ id: 'e1', step: 'add one item to the cart' }, { id: 'e2', verify: 'the cart shows one item' }, { id: 'e3', step: 'pay with the test card' }],
    },
    expect: { result: 'pass', failureType: null },
  },
  {
    id: 'stale',
    native: 'the step ends because its target is gone (e2e LOCATOR_NOT_FOUND)',
    case: {
      id: 'stale',
      Context: {},
      Intent: 'A shopper can open checkout',
      Execution: [{ id: 'e1', step: 'add one item to the cart' }, { id: 'e2', step: CONFORMANCE_MARKERS.staleTarget }],
    },
    expect: { result: 'fail', failedStep: 'e2', failureType: 'outdated-test-logic' },
  },
  {
    id: 'defect',
    native: 'the Intent judgment says false',
    case: { id: 'defect', Context: {}, Intent: 'The total applies the discount', Execution: [{ id: 'e1', step: 'apply the code SAVE10' }] },
    expect: { result: 'fail', failedStep: 'intent', failureType: 'product-defect' },
  },
  {
    id: 'evidence',
    native: 'an evidence hook returns false',
    case: {
      id: 'evidence',
      Context: {},
      Intent: { statement: 'An order is persisted', judge: false, evidence: [{ id: 'order-record', hook: 'orderMissing' }] },
      Execution: [{ id: 'e1', step: 'place an order' }],
    },
    expect: { result: 'fail', failedStep: 'order-record', failureType: 'product-defect' },
  },
  {
    id: 'violation',
    native: 'the runner enforces a guardrail: a denied action or a blocked request',
    case: { id: 'violation', Context: {}, Intent: 'A support agent can view an order', Guardrails: [NO_REFUND], Execution: [{ id: 'e1', step: `${CONFORMANCE_MARKERS.forbiddenRequest} to see its details` }] },
    expect: { result: 'fail', failedStep: 'e1', failureType: null, signals: ['guardrail-violation:no-refund'] },
  },
  {
    id: 'refusal',
    native: 'the agent stops itself, citing the guardrail by id',
    case: {
      id: 'refusal',
      Context: {},
      Intent: 'A user can clear a finished todo',
      Guardrails: [{ id: 'no-delete', rule: 'Never delete a todo' }],
      Execution: [{ id: 'e1', step: `${CONFORMANCE_MARKERS.refusal} "Old task"` }],
    },
    expect: { result: 'fail', failedStep: 'e1', failureType: null, signals: ['guardrail-refused:no-delete'] },
  },
  {
    id: 'unreachable',
    native: "the act step's goal can't be reached",
    case: { id: 'unreachable', Context: {}, Intent: 'A visitor can pick monthly billing', Execution: [{ id: 'e1', step: `${CONFORMANCE_MARKERS.unreachable} and pick monthly billing` }] },
    expect: { result: 'fail', failedStep: 'e1', failureType: null, signals: ['goal-unreachable'] },
  },
  {
    id: 'limit',
    native: 'the step runs out of room: an unsupported action, a spent budget',
    case: { id: 'limit', Context: {}, Intent: 'A user can move a card to Done', Execution: [{ id: 'e1', step: `${CONFORMANCE_MARKERS.budget} to Done` }] },
    expect: { result: 'fail', failedStep: 'e1', failureType: null, signals: ['automation-limit'] },
  },
  {
    id: 'missing-information',
    native: 'the agent stops for information the case does not give',
    case: { id: 'missing-information', Context: {}, Intent: 'A support agent can find an account', Execution: [{ id: 'e1', step: CONFORMANCE_MARKERS.missingInformation }] },
    expect: { result: 'fail', failedStep: 'e1', failureType: null, signals: ['missing-information'] },
  },
  {
    id: 'inconclusive',
    native: "an evidence hook can't reach its backend (a plain throw)",
    case: {
      id: 'inconclusive',
      Context: {},
      Intent: { statement: 'An order reaches the warehouse', judge: false, evidence: [{ id: 'warehouse', hook: 'backendDown' }] },
      Execution: [{ id: 'e1', step: 'place an order' }],
    },
    expect: { result: 'fail', failedStep: 'warehouse', failureType: null, signals: ['inconclusive-evidence'] },
  },
  {
    id: 'plugin-step',
    native: "a plugin's step throws a plain error",
    case: { id: 'plugin-step', Context: {}, Intent: 'The orders API answers', Execution: [{ id: 'e1', step: 'open the orders page' }, { id: 'e2', use: 'order-api', with: { status: 500 } }] },
    expect: { result: 'fail', failedStep: 'e2', failureType: null, signals: ['plugin-step-failed:e2'] },
  },
  {
    id: 'infrastructure',
    native: 'a precondition finds the environment down',
    case: { id: 'infrastructure', Context: { preconditions: [{ hook: 'environmentDown' }] }, Intent: 'A shopper can browse the catalog', Execution: [{ id: 'e1', step: 'open the catalog' }] },
    expect: { result: 'fail', failureType: 'infrastructure' },
  },
];

/** The hooks the scenarios name. Runner-neutral: none reads its fixtures. */
export const conformanceHooks: CigeHooks = {
  orderExists: () => true,
  orderMissing: () => false,
  environmentDown: () => {
    throw new CigeError('ENVIRONMENT_UNAVAILABLE', 'the staging API is down');
  },
  backendDown: () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9');
  },
};

/** The plugin the plugin-step scenario uses, on every runner. */
export const conformancePlugin: CigePlugin = {
  name: 'conformance',
  runners: ['*'],
  steps: {
    'order-api': ({ step }) => {
      if (step.with.status !== 200) throw new Error(`the orders API answered ${String(step.with.status)}`);
    },
  },
};

export interface ConformanceReport {
  /** Scenario id → what differs; empty when the adapter conforms. */
  readonly problems: Readonly<Record<string, readonly string[]>>;
  readonly checked: readonly string[];
  readonly unsupported: Readonly<Record<string, string>>;
}

/**
 * Compares an adapter's summaries with what each scenario expects.
 * `unsupported` names the scenarios the runner can't natively produce, with
 * why; every other scenario must have a summary.
 */
export function checkConformance(
  summaries: Readonly<Record<string, CigeRunSummary>>,
  unsupported: Readonly<Record<string, string>> = {},
  scenarios: readonly ConformanceScenario[] = CONFORMANCE_SCENARIOS,
): ConformanceReport {
  const problems: Record<string, string[]> = {};
  const checked: string[] = [];
  for (const scenario of scenarios) {
    if (Object.hasOwn(unsupported, scenario.id)) continue;
    checked.push(scenario.id);
    const found: string[] = [];
    const summary = summaries[scenario.id];
    if (summary === undefined) {
      problems[scenario.id] = ['no summary'];
      continue;
    }
    const { expect } = scenario;
    if (summary.result !== expect.result) found.push(`result ${summary.result}, expected ${expect.result}`);
    if (expect.failedStep !== undefined && summary.failedStep !== expect.failedStep) found.push(`failedStep ${summary.failedStep ?? 'absent'}, expected ${expect.failedStep}`);
    if (expect.failureType === null && summary.failureType !== undefined) found.push(`failureType ${summary.failureType}, expected none`);
    if (expect.failureType !== undefined && expect.failureType !== null && summary.failureType !== expect.failureType) found.push(`failureType ${summary.failureType ?? 'absent'}, expected ${expect.failureType}`);
    for (const signal of expect.signals ?? []) {
      if (!summary.classification.signals.includes(signal)) found.push(`no ${signal} among ${summary.classification.signals.join(', ')}`);
    }
    if (found.length > 0) problems[scenario.id] = found;
  }
  return { problems, checked, unsupported };
}
