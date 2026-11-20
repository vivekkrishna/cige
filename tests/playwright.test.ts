/**
 * The Playwright adapter's parts with no browser: how Playwright's errors
 * read as signals (shapes copied from real Playwright 1.65 errors), the
 * verdict line a healer reads, the reporter's reading of a result, the
 * scaffold `cige compile` writes, the healer block, readiness, and routing.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import type { TestResult } from '@playwright/test/reporter';

import { failureOfResult, outcomeOfResult, caseOfTags } from '../src/adapters/playwright/reporter.ts';
import { playwrightFailure } from '../src/adapters/playwright/errors.ts';
import { healerBlock, HEALER_BEGIN, withHealerBlock } from '../src/adapters/playwright/healer.ts';
import { needsJudge, playwrightRunner, PLAYWRIGHT_CAPABILITIES, specsBinding } from '../src/adapters/playwright/runner.ts';
import { boundIds, configImport, renderSpec, renderStubs, specPathFor } from '../src/adapters/playwright/scaffold.ts';
import { opIdOfTitle, stepTitle } from '../src/adapters/playwright/session.ts';
import { classifyFailure, OUTCOME_ATTACHMENT, verdictLine } from '../src/adapters/playwright/verdict.ts';
import { capabilityGaps } from '../src/core/check.ts';
import { planCase, type CigeOp } from '../src/core/plan.ts';
import { routeCase } from '../src/core/route.ts';
import { parseCige } from '../src/core/schema.ts';
import { summarize } from '../src/core/summary.ts';
import { cigeGrep } from '../src/core/tags.ts';

const ROOT = fileURLToPath(new URL('./tmp-projects/playwright-unit/', import.meta.url));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const checkout = parseCige(
  {
    id: 'checkout',
    Context: { system: 'Shop' },
    Intent: { statement: 'A shopper can pay', judge: false, evidence: [{ id: 'order', hook: 'orderExists' }] },
    Guardrails: [{ id: 'no-real-payments', rule: 'Never charge a real card', 'x-deny-requests': ['POST **/payments*'] }, 'Use only the test card'],
    Execution: [{ id: 'e1', step: 'add {sku} to the cart' }, { id: 'e2', verify: 'the cart shows one item' }, { id: 'e3', use: 'order-api', with: {} }],
    Variants: [{ id: 'book', params: { sku: 'BOOK-1' } }],
  },
  'checkout',
);
const [act, verify] = planCase(checkout).filter((op) => op.kind === 'act' || op.kind === 'verify') as [CigeOp, CigeOp];

/** An error with Playwright's shape: a name, an ANSI-colored message, and `matcherResult` for a failed expect. */
function pwError(name: string, message: string, expectFailure = false): Error {
  const error = new Error(message);
  error.name = name;
  if (expectFailure) Object.assign(error, { matcherResult: { pass: false } });
  return error;
}

describe("Playwright's errors as signals", () => {
  const cases: [string, Error, CigeOp, string, string[]][] = [
    ['a locator that never resolved', pwError('TimeoutError', "locator.click: Timeout 1000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Old' })\u001b[22m\n"), act, 'LOCATOR_NOT_FOUND', ['step.target-missing']],
    ['a locator that resolved, on an element that never became clickable', pwError('TimeoutError', 'locator.click: Timeout 1000ms exceeded.\nCall log:\n  - waiting for locator(\'#d\')\n    - locator resolved to <button id="d" disabled>Dis</button>\n      - element is not enabled'), act, 'ACTION_FAILED', ['step.action-failed']],
    ['a strict mode violation', pwError('Error', "locator.click: Error: strict mode violation: getByRole('button', { name: 'Pay' }) resolved to 2 elements"), act, 'LOCATOR_AMBIGUOUS', ['step.target-ambiguous']],
    ['a failed expect in a verify', pwError('Error', '\u001b[2mexpect(\u001b[22mlocator).toHaveText(expected) failed\n\nExpected: "20"\nReceived: "10"', true), verify, 'ASSERTION_FAILED', ['assert.false']],
    ['a failed expect in an act step', pwError('Error', 'expect(locator).toContainText(expected) failed', true), act, 'ASSERTION_FAILED', ['step.goal-unreached']],
    ['an expect that found no element', pwError('Error', "expect(locator).toHaveText(expected) failed\n\nLocator: locator('#nope')\nError: element(s) not found", true), verify, 'LOCATOR_NOT_FOUND', ['step.target-missing']],
    ['a refused connection', pwError('Error', 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'), act, 'ENVIRONMENT_UNAVAILABLE', ['env.unavailable']],
    ['a navigation timeout', pwError('TimeoutError', 'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "http://localhost:3000/", waiting until "load"'), act, 'ENVIRONMENT_UNAVAILABLE', ['env.unavailable']],
    ['a wait with nothing to blame', pwError('TimeoutError', 'page.waitForEvent: Timeout 300ms exceeded while waiting for event "download"'), act, 'PLAYWRIGHT_TIMEOUT', ['step.limit']],
    ['anything else', pwError('TypeError', "Cannot read properties of undefined (reading 'x')"), act, 'PLAYWRIGHT_ERROR', []],
  ];
  for (const [what, error, op, code, signals] of cases) {
    it(`reads ${what} as ${code}`, () => {
      const failure = playwrightFailure(error, op);
      expect(failure.code).toBe(code);
      expect(failure.signals.map((signal) => signal.kind)).toEqual(signals);
      expect(failure.message).not.toContain('\u001b[');
    });
  }

  it('keeps the code an e2e AgentError a shared hook threw', () => {
    const agentError = Object.assign(new Error('the API is down'), { code: 'ENVIRONMENT_UNAVAILABLE' });
    expect(playwrightFailure(agentError, act).signals).toEqual([{ kind: 'env.unavailable' }]);
  });
});

describe('the verdict line a healer reads', () => {
  const at = (step: string, code: string, signals: ReturnType<typeof playwrightFailure>['signals'], phase: 'execution' | 'evidence' = 'execution') =>
    verdictLine(checkout, classifyFailure(checkout, { phase, failedStep: step, code, signals }), '.e2e/cige/checkout.run-summary.json');

  it('allows a binding repair only on outdated test logic', () => {
    expect(at('e1', 'LOCATOR_NOT_FOUND', [{ kind: 'step.target-missing' }])).toBe(
      'CIGE checkout failed at step e1: outdated-test-logic. The flow changed under this step: repairing its binding in the .cige.spec.ts file is allowed; leave the case\'s Intent, Guardrails, evidence, and cige.config.ts as they are. Summary: .e2e/cige/checkout.run-summary.json',
    );
  });

  it('forbids changing the test on a product defect', () => {
    expect(at('e2', 'ASSERTION_FAILED', [{ kind: 'assert.false' }])).toContain('product-defect. The app contradicts the Intent: do not change this test, its expected values, or mark it fixme');
  });

  it('names a blocked request and forbids loosening the guardrail', () => {
    expect(at('e1', 'POLICY_DENIED', [{ kind: 'guardrail.violated', detail: 'no-real-payments' }])).toContain('guardrail no-real-payments blocked a forbidden request. Do not loosen the guardrail');
  });

  it('says to classify first when the signals decide nothing', () => {
    expect(at('e1', 'PLAYWRIGHT_ERROR', [])).toContain('not classified (code:PLAYWRIGHT_ERROR). Classify it before changing anything.');
  });
});

/** A Playwright result, as much of it as the reporter reads. */
function result(fields: Partial<TestResult>): TestResult {
  return { retry: 0, status: 'failed', errors: [], attachments: [], steps: [], duration: 1, startTime: new Date(), parallelIndex: 0, workerIndex: 0, stdout: [], stderr: [], annotations: [], ...fields } as TestResult;
}

describe('the reporter reading a result', () => {
  const resolved = { ...checkout, variant: 'book', params: { sku: 'BOOK-1' } };

  it('reads the tags a test carries back to its case and variant', () => {
    expect(caseOfTags(['@cige', '@cige:checkout', '@cige:checkout/book'])).toEqual({ id: 'checkout', variant: 'book' });
    expect(caseOfTags(['@smoke'])).toBeUndefined();
  });

  it('takes the failure the test attached', () => {
    const attached = { phase: 'execution', failedStep: 'e2', signals: [{ kind: 'assert.false' }], code: 'ASSERTION_FAILED', message: 'no' };
    const read = result({ attachments: [{ name: OUTCOME_ATTACHMENT, contentType: 'application/json', body: Buffer.from(JSON.stringify(attached)) }] });
    expect(failureOfResult(resolved, read)).toEqual(attached);
  });

  it("reads a timeout from its steps: the last CIGE step that ran, stopped by the clock, whatever the test said", () => {
    const steps = [{ title: stepTitle(act), error: undefined }, { title: stepTitle(verify), error: { message: 'Target page, context or browser has been closed' } }] as TestResult['steps'];
    const attached = { phase: 'execution', failedStep: 'e2', signals: [{ kind: 'env.unavailable' }], code: 'ENVIRONMENT_UNAVAILABLE' };
    const read = result({ status: 'timedOut', steps, errors: [{ message: 'Test timeout of 30000ms exceeded.' }], attachments: [{ name: OUTCOME_ATTACHMENT, contentType: 'application/json', body: Buffer.from(JSON.stringify(attached)) }] });
    expect(failureOfResult(resolved, read)).toEqual({ phase: 'execution', failedStep: 'e2', signals: [{ kind: 'run.stopped' }], code: 'TEST_TIMEOUT', message: 'Test timeout of 30000ms exceeded.' });
    expect(outcomeOfResult(resolved, read).status).toBe('timed-out');
  });

  it('reads a failure before the body ran (a browser that never launched) as the environment', () => {
    const read = result({ errors: [{ message: 'browserType.launch: net::ERR_CONNECTION_REFUSED' }] });
    expect(failureOfResult(resolved, read)).toMatchObject({ phase: 'precondition', code: 'ENVIRONMENT_UNAVAILABLE', signals: [{ kind: 'env.unavailable' }] });
  });

  it('calls a pass on a retry flaky', () => {
    expect(outcomeOfResult(resolved, result({ status: 'passed', retry: 1 }))).toEqual({ result: 'pass', status: 'flaky' });
  });

  it('round-trips a step title to the operation id', () => {
    expect(opIdOfTitle(stepTitle(act))).toBe('e1');
    expect(stepTitle({ kind: 'precondition', phase: 'precondition', hook: 'seed' })).toBe('CIGE precondition seed');
    expect(opIdOfTitle('CIGE precondition seed')).toBeUndefined();
  });
});

describe('the scaffold cige compile writes', () => {
  const spec = renderSpec(checkout, '../cige.config.ts');

  it('binds every act and verify step, leaves plugin steps to their plugin, and fails until written', () => {
    expect(boundIds(spec)).toEqual(['e1', 'e2']);
    expect(spec).toContain("cigeTest(config, 'checkout', {");
    expect(spec).toContain("throw new CigeError('STEP_NOT_COMPILED', 'e1 is not compiled yet: write its Playwright code');");
    expect(spec).toContain('// Plugin steps run by their plugin, not here: e3 (order-api).');
    expect(spec).toContain('// Values: params.sku');
    expect(spec).toContain('e1: async ({ page, params }) => {');
  });

  it('writes the guardrails beside the bindings and says which ones are enforced', () => {
    expect(spec).toContain('// - [no-real-payments] Never charge a real card');
    expect(spec).toContain('//   Enforced: requests to POST **/payments* are blocked, and the step that sends one fails.');
    expect(spec).toContain('// - [g2] Use only the test card');
  });

  it('prints only the stubs a spec lacks, and places files beside the case', () => {
    expect(renderStubs(checkout, ['e2'])).toContain('e2: async ({ page, params }) => {');
    expect(renderStubs(checkout, ['e2'])).not.toContain('e1:');
    expect(specPathFor('/p/tests/checkout.cige.json')).toBe('/p/tests/checkout.cige.spec.ts');
    expect(configImport('/p/tests/checkout.cige.spec.ts', '/p/cige.config.ts')).toBe('../cige.config.ts');
    expect(configImport('/p/checkout.cige.spec.ts', '/p/cige.config.ts')).toBe('./cige.config.ts');
    expect(boundIds("  'step-1': async ({ page }) => {}\n  e2 : async () => {}")).toEqual(['step-1', 'e2']);
  });
});

describe('the healer block', () => {
  it('appends once, then replaces itself in place', () => {
    const agent = '---\nname: playwright-test-healer\n---\n\nYou are the Playwright Test Healer.\n';
    const once = withHealerBlock(agent, healerBlock());
    expect(once.startsWith(agent.trimEnd())).toBe(true);
    const moved = withHealerBlock(once, healerBlock('out/cige'));
    expect(moved.split(HEALER_BEGIN).length).toBe(2);
    expect(moved).toContain('out/cige/<id>.run-summary.json');
    expect(withHealerBlock(moved, healerBlock('out/cige'))).toBe(moved);
  });
});

describe('selecting cases in Playwright', () => {
  it('greps a tag exactly, never a longer id that starts with it', () => {
    const grep = new RegExp(cigeGrep(['cige:checkout']));
    expect(grep.test('A shopper can pay @cige @cige:checkout')).toBe(true);
    expect(grep.test('A shopper can pay @cige @cige:checkout-v2')).toBe(false);
    expect(grep.test('A shopper can pay @cige @cige:checkout/book')).toBe(false);
    const all = new RegExp(cigeGrep(['cige']));
    expect(all.test('A shopper can pay @cige @cige:checkout')).toBe(true);
    expect(new RegExp(cigeGrep(['cige:a.b'])).test('@cige:aXb')).toBe(false);
  });
});

describe('readiness and routing', () => {
  mkdirSync(path.join(ROOT, 'tests'), { recursive: true });
  writeFileSync(path.join(ROOT, 'tests', 'checkout.cige.spec.ts'), "cigeTest(config, 'checkout', {});\n");
  const judged = parseCige({ id: 'judged', Context: { session: 'admin', agent: 'fast' }, Intent: 'An admin can see orders', Execution: [{ id: 'e1', step: 'open orders' }] }, 'judged');

  it('blocks a case no spec binds, one judged on the screen with no judge, and a session it has no file for', () => {
    const runner = playwrightRunner();
    expect(specsBinding('checkout', ROOT)).toEqual([path.join(ROOT, 'tests', 'checkout.cige.spec.ts')]);
    expect(runner.readiness!(checkout, { root: ROOT }).blocking).toEqual([]);
    expect(needsJudge(judged)).toBe(true);
    expect(runner.readiness!(judged, { root: ROOT }).blocking).toEqual([
      "no spec binds its steps: write one with npx cige compile judged (cigeTest(config, 'judged', {...}) in a **/*.cige.spec.ts file)",
      'it is judged on the screen (the Intent, or an evidence assert), and playwrightRunner has no judge: set judge, or prove the Intent with hook evidence and "judge": false',
      'Context.session "admin" has no storageState file in playwrightRunner\'s sessions',
    ]);
    const ready = playwrightRunner({ judge: () => ({ status: 'passed' }), sessions: { admin: '.auth/admin.json' } });
    expect(ready.readiness!(judged, { root: ROOT }).blocking).toEqual([expect.stringContaining('no spec binds its steps')]);
  });

  it('reports the gaps in check, Context.agent ignored among them', () => {
    const gaps = capabilityGaps(judged, playwrightRunner(), {}, { root: ROOT }).map((gap) => gap.detail);
    expect(gaps).toContain('playwright runs bound code, not an agent: Context.agent is ignored');
    expect(gaps).toContainEqual(expect.stringContaining('no spec binds its steps'));
  });

  it('leaves a runner out of auto for a case it blocks', () => {
    const runner = playwrightRunner();
    const candidate = { name: 'playwright', capabilities: PLAYWRIGHT_CAPABILITIES, availability: { ok: true }, blocking: (testCase: typeof checkout) => runner.readiness!(testCase, { root: ROOT }).blocking ?? [] };
    const plugins = [{ name: 'orders', runners: ['*'], steps: { 'order-api': () => undefined } }];
    expect(routeCase(checkout, [candidate], new Map(), { plugins }).runner).toBe('playwright');
    const decision = routeCase(judged, [candidate], new Map(), {});
    expect(decision.runner).toBeUndefined();
    expect(decision.reason).toContain('no spec binds its steps');
  });
});

describe('the replay command in a summary', () => {
  it("is Playwright's own, with its config, when the config declares no environments", () => {
    const summary = summarize(
      {
        key: { id: 'checkout', variant: 'book' },
        name: 'checkout.book',
        runner: { name: 'playwright', version: '1.65.0' },
        testCase: { ...checkout, variant: 'book' },
        outcome: { result: 'pass', status: 'passed' },
        runDate: '2026-11-19',
        target: 'chromium',
        agent: 'default',
        attempts: 1,
        carried: false,
        narrow: [],
        evidence: { resultId: 'x', artifacts: [] },
      },
      { config: { runners: { playwright: playwrightRunner({ config: 'e2e/playwright.config.ts' }) } }, outputDir: '/p/.e2e/cige', projectRoot: '/p' },
    );
    expect(summary.replay.command).toBe("npx playwright test --config e2e/playwright.config.ts --grep '@cige:checkout/book(?![\\w:./-])' --retries 0");
  });
});
