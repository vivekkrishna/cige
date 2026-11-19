/**
 * The Vibium adapter and the owned loop on a scripted Vibium: no browser,
 * no model. What the adapter asks Vibium for (the goal with its Context,
 * guardrails, and values; the claims; the archive judge; the routes), how
 * each native outcome is classified, and how the loop retries, reruns, and
 * keeps other runners' summaries.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runnerFailure } from '../src/adapters/vibium/outcomes.ts';
import { vibiumRunner } from '../src/adapters/vibium/runner.ts';
import { capabilityGaps } from '../src/core/check.ts';
import type { CigeConfig } from '../src/core/config.ts';
import { CigeError } from '../src/core/errors.ts';
import { runCases, type RunCasesOptions } from '../src/core/owned.ts';
import type { CigeRunSummary } from '../src/core/summary.ts';
import { parseCige, type CigeTestCase } from '../src/core/schema.ts';
import { conformanceHooks, conformancePlugin } from '../src/runner/conformance.ts';
import { fakeVibium, type FakeOptions } from './helpers/fake-vibium.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(cases: Record<string, CigeTestCase>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cige-vibium-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'cases'));
  for (const [name, testCase] of Object.entries(cases)) writeFileSync(path.join(dir, 'cases', `${name}.cige.json`), JSON.stringify(testCase));
  return dir;
}

function summariesIn(dir: string): Record<string, CigeRunSummary> {
  const out = path.join(dir, '.e2e', 'cige');
  return Object.fromEntries(
    readdirSync(out)
      .filter((file) => file.endsWith('.run-summary.json'))
      .map((file) => [file.slice(0, -'.run-summary.json'.length), JSON.parse(readFileSync(path.join(out, file), 'utf8')) as CigeRunSummary]),
  );
}

async function runOn(dir: string, fake: FakeOptions = {}, { config: own, ...extra }: Partial<RunCasesOptions> & { config?: CigeConfig } = {}) {
  const vibium = fakeVibium(fake);
  const config: CigeConfig = { cases: 'cases/*.cige.json', hooks: conformanceHooks, plugins: [conformancePlugin], ...own };
  const result = await runCases({
    config,
    configDir: dir,
    projectRoot: dir,
    outputDir: path.join(dir, '.e2e', 'cige'),
    runner: vibiumRunner({ load: async () => vibium.module, version: 'fake-1', model: { provider: 'anthropic' } }),
    ...extra,
  });
  return { result, vibium, summaries: summariesIn(dir) };
}

const CHECKOUT: CigeTestCase = {
  id: 'checkout',
  Context: {
    system: 'Shop',
    environment: 'staging',
    open: '/cart',
    actor: 'a signed-in shopper',
    facts: ['A discount code SAVE10 exists'],
    specRef: 'specs/checkout.md',
  },
  Intent: { statement: 'A shopper can check out', success: ['The confirmation shows an order number'], evidence: [{ id: 'order-record', hook: 'orderExists' }, 'the cart is empty'] },
  Guardrails: [{ id: 'no-payments', rule: 'Never submit a real payment', 'x-deny-requests': ['POST **/payments*'] }],
  Execution: [
    { id: 'e1', step: 'apply the code {code}', params: { code: 'SAVE10' } },
    { id: 'e2', verify: 'the total is reduced' },
  ],
};

describe('the Vibium session', () => {
  it('leads every goal and claim with the Context, carries the guardrails and values, and judges the Intent on the recording', async () => {
    const dir = project({ checkout: CHECKOUT });
    const { result, vibium, summaries } = await runOn(dir, {}, { config: { environments: { staging: { baseURL: 'https://staging.shop.test', reset: () => undefined } } } });
    expect(result.exitCode).toBe(0);
    const calls = vibium.calls.map((call) => call.api);
    expect(calls).toEqual(['browser.start', 'recording.start', 'page.route', 'page.go', 'page.run', 'page.check', 'page.check', 'recording.stop', 'browser.check']);
    const [goal] = vibium.calls.filter((call) => call.api === 'page.run');
    expect(goal!.text).toContain('Context:\nSystem under test: Shop\nEnvironment: staging\nActing as: a signed-in shopper\nKnown state:\n- A discount code SAVE10 exists');
    expect(goal!.text).toContain('Task:\napply the code SAVE10');
    expect(goal!.text).toContain('- [no-payments] Never submit a real payment');
    expect(goal!.text).toContain('Values:\n- code: SAVE10');
    expect(goal!.text).not.toContain('specs/checkout.md');
    expect(goal!.options).toEqual({ provider: 'anthropic', baseURL: 'https://staging.shop.test' });
    expect(vibium.calls.find((call) => call.api === 'page.go')!.text).toBe('https://staging.shop.test/cart');
    expect(vibium.calls.find((call) => call.api === 'page.route')!.text).toBe('**/payments*');
    const judge = vibium.calls.find((call) => call.api === 'browser.check')!;
    expect(judge.text).toContain('Claim:\nA shopper can check out\n\nAll of these hold:\n- The confirmation shows an order number');
    expect(judge.options).toMatchObject({ provider: 'anthropic', record: path.join(dir, '.e2e', 'cige', 'recordings', 'checkout.attempt-1.zip') });
    expect(vibium.state.groups).toEqual(['open', 'e1', 'e2', 'order-record', 'v2']);
    expect(vibium.state.stopped).toBe(1);
    expect(summaries.checkout).toMatchObject({
      testId: 'checkout',
      result: 'pass',
      runner: { name: 'vibium', version: 'fake-1' },
      target: 'staging',
      evidence: { recording: '.e2e/cige/recordings/checkout.attempt-1.zip', artifacts: ['.e2e/cige/recordings/checkout.attempt-1.zip'] },
      replay: { environment: 'staging', command: 'npx cige replay checkout --runner vibium' },
    });
    expect(summaries.checkout!.evidence.groups).toEqual(vibium.state.groups);
  });

  it('judges live on the page when asked, and keeps the recording open until the session stops', async () => {
    const dir = project({ checkout: { ...CHECKOUT, Context: { system: 'Shop' } } });
    const vibium = fakeVibium();
    await runCases({
      config: { cases: 'cases/*.cige.json', hooks: conformanceHooks },
      configDir: dir,
      projectRoot: dir,
      outputDir: path.join(dir, '.e2e', 'cige'),
      runner: vibiumRunner({ load: async () => vibium.module, judge: 'live' }),
    });
    const apis = vibium.calls.map((call) => call.api);
    expect(apis).not.toContain('browser.check');
    expect(apis.slice(-2)).toEqual(['page.check', 'recording.stop']);
  });

  it('fails a step whose request a guardrail blocks, as that guardrail violated, even when the agent says it completed', async () => {
    const dir = project({
      refund: {
        id: 'refund',
        Context: {},
        Intent: 'A support agent can view an order',
        Guardrails: [{ id: 'no-refund', rule: 'Never refund an order', 'x-deny-requests': ['POST **/refund*'] }],
        Execution: [{ id: 'e1', step: 'refund the order to see its details' }],
      },
    });
    const { vibium, summaries } = await runOn(dir);
    expect(vibium.state.aborted).toEqual(['POST http://shop.test/api/refund']);
    expect(summaries.refund).toMatchObject({
      result: 'fail',
      failedStep: 'e1',
      classification: { errorCode: 'POLICY_DENIED', signals: expect.arrayContaining(['guardrail-violation:no-refund']) },
    });
    expect(summaries.refund!.failureType).toBeUndefined();
  });

  it('lets a request through when the method differs from the rule', async () => {
    const dir = project({
      refund: {
        id: 'refund',
        Context: {},
        Intent: 'A support agent can view an order',
        Guardrails: [{ id: 'no-refund', rule: 'Never refund an order', 'x-deny-requests': ['DELETE **/refund*'] }],
        Execution: [{ id: 'e1', step: 'refund the order to see its details' }],
      },
    });
    const { vibium, summaries } = await runOn(dir);
    expect(vibium.state.aborted).toEqual([]);
    expect(summaries.refund?.result).toBe('pass');
  });

  it('refuses a malformed x-deny-requests before the browser starts', async () => {
    const dir = project({
      bad: { id: 'bad', Context: {}, Intent: 'A visitor sees the home page', Guardrails: [{ id: 'g1', rule: 'Never pay', 'x-deny-requests': 'POST /pay' }], Execution: [{ id: 'e1', step: 'look' }] },
    });
    const { vibium, summaries } = await runOn(dir);
    expect(vibium.state.started).toBe(0);
    expect(summaries.bad).toMatchObject({ result: 'fail', failureType: 'infrastructure', classification: { errorCode: 'TEST_SETUP_FAILED' } });
  });

  it('reads a browser that never starts as infrastructure, and a rejected model key as the provider', async () => {
    const dir = project({ one: { id: 'one', Context: {}, Intent: 'A visitor sees the home page', Execution: [{ id: 'e1', step: 'look at the page' }] } });
    const down = await runOn(dir, { startFails: 'chrome is not installed' });
    expect(down.summaries.one).toMatchObject({ result: 'fail', failureType: 'infrastructure', classification: { phase: 'precondition', errorCode: 'ENVIRONMENT_UNAVAILABLE' } });
    const key = await runOn(dir, { runThrows: '401 Unauthorized: invalid x-api-key' });
    expect(key.summaries.one).toMatchObject({ result: 'fail', failedStep: 'e1', failureType: 'infrastructure', classification: { errorCode: 'PROVIDER_ERROR' } });
    expect(key.vibium.state.stopped).toBe(1);
  });

  it("reads the errors vibium 26.11.16 throws for a model it can't reach as the provider", () => {
    // Captured from the real binary with no model configured.
    for (const message of [
      'error: set VIBIUM_AI_PROVIDER to openai, xai, anthropic, google, openai-compatible, or local',
      'error: VIBIUM_AI_MODEL is required; changing provider requires an explicit model override (--model in CLI)',
      'error: ANTHROPIC_API_KEY is required',
    ]) {
      const failure = runnerFailure(Object.assign(new Error(message), { name: 'BiDiError' }), 'browser.check');
      expect([failure.code, failure.signals]).toEqual(['PROVIDER_ERROR', [{ kind: 'provider.error' }]]);
    }
  });

  it('marks archive evidence the judge could not find', async () => {
    const dir = project({ one: { id: 'one', Context: {}, Intent: 'A visitor sees the home page', Execution: [{ id: 'e1', step: 'look at the page' }] } });
    const vibium = fakeVibium();
    // A recording that never lands: the archive judge has nothing to read.
    const broken = {
      browser: {
        ...vibium.module.browser,
        async start(options?: Parameters<typeof vibium.module.browser.start>[0]) {
          const browser = await vibium.module.browser.start(options);
          const page = await browser.page();
          const recording = { ...page.context.recording, stop: async () => ({ path: path.join(dir, 'nowhere.zip') }) };
          return { ...browser, page: async () => ({ ...page, run: page.run, check: page.check, go: page.go, route: page.route, context: { recording } }) };
        },
      },
    };
    await runCases({
      config: { cases: 'cases/*.cige.json' },
      configDir: dir,
      projectRoot: dir,
      outputDir: path.join(dir, '.e2e', 'cige'),
      runner: vibiumRunner({ load: async () => broken }),
    });
    expect(summariesIn(dir).one).toMatchObject({
      result: 'fail',
      failedStep: 'intent',
      classification: { errorCode: 'CHECK_INCONCLUSIVE', signals: expect.arrayContaining(['inconclusive-evidence', 'archive-missing-evidence']) },
    });
  });

  it('hands hooks Vibium fixtures and the runner, and keeps an e2e-style code a shared hook throws', async () => {
    const seen: string[] = [];
    const dir = project({ one: { id: 'one', Context: { preconditions: [{ hook: 'seed' }] }, Intent: 'A visitor sees the home page', Execution: [{ id: 'e1', step: 'look at the page' }] } });
    const { summaries } = await runOn(dir, {}, {
      config: {
        cases: 'cases/*.cige.json',
        hooks: {
          seed: (fixtures, _testCase, info) => {
            seen.push(`${info.runner}:${typeof (fixtures as { page?: unknown }).page}`);
            throw Object.assign(new Error('seed data missing'), { code: 'SEED_DATA_MISSING' });
          },
        },
      },
    });
    expect(seen).toEqual(['vibium:object']);
    expect(summaries.one).toMatchObject({ failureType: 'infrastructure', classification: { errorCode: 'SEED_DATA_MISSING', phase: 'precondition' } });
  });

  it("names a Context.agent the runner doesn't know, and uses the model of one it does", async () => {
    const dir = project({ one: { id: 'one', Context: { agent: 'careful' }, Intent: 'A visitor sees the home page', Execution: [{ id: 'e1', step: 'look at the page' }] } });
    const vibium = fakeVibium();
    const base = { config: { cases: 'cases/*.cige.json' }, configDir: dir, projectRoot: dir, outputDir: path.join(dir, '.e2e', 'cige') };
    await runCases({ ...base, runner: vibiumRunner({ load: async () => vibium.module }) });
    expect(summariesIn(dir).one).toMatchObject({ failureType: 'infrastructure', classification: { message: expect.stringContaining('Context.agent "careful"') } });
    await runCases({ ...base, runner: vibiumRunner({ load: async () => vibium.module, model: { provider: 'anthropic' }, agents: { careful: { model: 'claude-opus-5-5' } } }) });
    expect(vibium.calls.find((call) => call.api === 'page.run')!.options).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(summariesIn(dir).one).toMatchObject({ result: 'pass', agent: 'careful' });
  });
});

describe('the owned loop', () => {
  const cases = {
    a: { id: 'a', Context: {}, Intent: 'A visitor can open A', Execution: [{ id: 'e1', step: 'open A' }] },
    b: { id: 'b', Context: {}, Intent: 'The total applies the discount', Execution: [{ id: 'e1', step: 'open B' }] },
    v: {
      id: 'v',
      Context: {},
      Intent: 'A shopper can pay by {method}',
      Execution: [{ id: 'e1', step: 'pay by {method}' }],
      Variants: [
        { id: 'card', params: { method: 'card' } },
        { id: 'ios', params: { method: 'wallet' }, platforms: ['ios'] },
      ],
    },
  } satisfies Record<string, CigeTestCase>;

  it('retries a failed attempt and calls a pass after a retry flaky', async () => {
    const dir = project({ a: cases.a });
    const { summaries } = await runOn(dir, { flakyRuns: 1 }, { retries: 1 });
    expect(summaries.a).toMatchObject({ result: 'pass', attempts: 2, classification: { signals: ['status:flaky', 'screen-only-evidence'] }, evidence: { recording: '.e2e/cige/recordings/a.attempt-2.zip' } });
  });

  it('skips a variant on a platform the runner does not run, and says so in check', async () => {
    const dir = project({ v: cases.v });
    const { summaries } = await runOn(dir);
    expect(summaries['v.card']?.result).toBe('pass');
    expect(summaries['v.ios']).toMatchObject({ result: 'skipped', classification: { signals: ['status:skipped'] } });
    const gaps = capabilityGaps(parseCige(cases.v), vibiumRunner(), {});
    expect(gaps).toEqual([{ kind: 'runner', runner: 'vibium', detail: 'vibium runs web, not ios: those runs are skipped' }]);
  });

  it('reruns only the last failures, keeping the other summaries, and runs them across workers in a stable order', async () => {
    const dir = project({ a: cases.a, b: cases.b, v: cases.v });
    const first = await runOn(dir, {}, { workers: 3 });
    expect(first.result.summaries.map((summary) => `${summary.testId}${summary.variant === undefined ? '' : `.${summary.variant}`}:${summary.result}`)).toEqual([
      'a:pass',
      'b:fail',
      'v.card:pass',
      'v.ios:skipped',
    ]);
    expect(first.result.exitCode).toBe(1);
    const aBefore = readFileSync(path.join(dir, '.e2e', 'cige', 'a.run-summary.json'), 'utf8');
    const rerun = await runOn(dir, {}, { lastFailed: true });
    expect(rerun.vibium.calls.filter((call) => call.api === 'page.run').map((call) => call.text.slice(call.text.indexOf('Task:')))).toEqual(['Task:\nopen B']);
    expect(Object.keys(rerun.summaries).toSorted()).toEqual(['a', 'b', 'v.card', 'v.ios']);
    expect(readFileSync(path.join(dir, '.e2e', 'cige', 'a.run-summary.json'), 'utf8')).toBe(aBefore);
  });

  it("clears only its own runner's earlier summaries on a full run", async () => {
    const dir = project({ a: cases.a });
    const out = path.join(dir, '.e2e', 'cige');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'old.run-summary.json'), JSON.stringify({ testId: 'old', runner: { name: 'vibium', version: '0' } }));
    writeFileSync(path.join(out, 'e2e-case.run-summary.json'), JSON.stringify({ testId: 'e2e-case' }));
    writeFileSync(path.join(out, 'notes.txt'), 'keep me');
    await runOn(dir);
    expect(readdirSync(out).toSorted()).toEqual(['a.run-summary.json', 'e2e-case.run-summary.json', 'notes.txt', 'recordings']);
  });

  it('refuses to run a case whose use step no plugin registers for vibium', async () => {
    const dir = project({ api: { id: 'api', Context: {}, Intent: 'The API answers', Execution: [{ id: 'e1', use: 'order-api', with: {} }] } });
    await expect(runOn(dir, {}, { config: { cases: 'cases/*.cige.json', plugins: [{ ...conformancePlugin, runners: ['e2e'] }] } })).rejects.toThrow(
      /step kind "order-api" is used by the case but no plugin registers it for vibium/,
    );
  });

  it('turns a CigeError a plugin step throws into its own verdict', async () => {
    const dir = project({ api: { id: 'api', Context: {}, Intent: 'The API answers', Execution: [{ id: 'e1', use: 'checked', with: {} }] } });
    const { summaries } = await runOn(dir, {}, {
      config: {
        cases: 'cases/*.cige.json',
        plugins: [{ name: 'api', runners: ['vibium'], steps: { checked: () => { throw new CigeError('ASSERTION_FAILED', 'GET /orders answered 404'); } } }],
      },
    });
    expect(summaries.api).toMatchObject({ failedStep: 'e1', failureType: 'product-defect', classification: { errorCode: 'ASSERTION_FAILED' } });
  });

  it('writes nothing it did not run, and leaves the recordings beside the summaries', async () => {
    const dir = project({ a: cases.a, b: cases.b });
    await runOn(dir, {}, { ids: ['b'] });
    expect(Object.keys(summariesIn(dir))).toEqual(['b']);
    expect(existsSync(path.join(dir, '.e2e', 'cige', 'recordings', 'b.attempt-1.zip'))).toBe(true);
  });
});
