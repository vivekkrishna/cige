/**
 * `auto` routing: which runner a case runs on, decided per case before it
 * runs, one rule at a time, with the reason it gives.
 */

import { describe, expect, it } from 'vitest';

import { E2E_CAPABILITIES } from '../src/adapters/e2e/runner.ts';
import { vibiumAvailability, VIBIUM_CAPABILITIES } from '../src/adapters/vibium/runner.ts';
import { routeCase, type RouteCandidate, type RunHistory } from '../src/core/route.ts';
import { parseCige, type CigeTestCase } from '../src/core/schema.ts';
import type { CigeRunSummary } from '../src/core/summary.ts';

const e2e: RouteCandidate = { name: 'e2e', capabilities: E2E_CAPABILITIES, availability: { ok: true } };
const vibium: RouteCandidate = { name: 'vibium', capabilities: VIBIUM_CAPABILITIES, availability: { ok: true } };
const both = [e2e, vibium];

const plain: CigeTestCase = { id: 'plain', Context: {}, Intent: 'A visitor sees the home page', Execution: [{ id: 'e1', step: 'look' }] };

function route(testCase: CigeTestCase, candidates: readonly RouteCandidate[] = both, history: RunHistory = new Map(), config = {}) {
  return routeCase(parseCige(testCase), candidates, history, config);
}

function past(id: string, runner: string, summary: Partial<CigeRunSummary>): RunHistory {
  return new Map([[id, new Map([[runner, { testId: id, runDate: '2026-11-18', result: 'fail', ...summary } as CigeRunSummary]])]]);
}

describe('auto routing', () => {
  it('sends a case to the runner that enforces its guardrails', () => {
    const requests = route({ ...plain, Guardrails: [{ id: 'no-pay', rule: 'Never pay', 'x-deny-requests': ['POST **/pay*'] }] });
    expect(requests).toMatchObject({ runner: 'vibium', reason: 'vibium: enforces every guardrail; e2e would only advise no-pay (x-deny-requests)' });
    const actions = route({ ...plain, Guardrails: [{ id: 'no-refund', rule: 'Never refund', deny: { actions: ['tool:refund'] } }] });
    expect(actions).toMatchObject({ runner: 'e2e', reason: 'e2e: enforces every guardrail; vibium would only advise no-refund (deny)' });
  });

  it('picks the runner that advises fewest when none enforces all', () => {
    const decision = route({
      ...plain,
      Guardrails: [
        { id: 'a', rule: 'Never refund', deny: { actions: ['tool:refund'] }, 'x-deny-requests': ['POST **/refund*'] },
        { id: 'b', rule: 'Never delete', deny: { actions: ['tool:delete'] } },
      ],
    });
    expect(decision).toMatchObject({ runner: 'e2e', reason: 'e2e: advises the fewest guardrails (a (x-deny-requests)); vibium would advise a (deny), b (deny)' });
  });

  it('excludes a runner that cannot serve the case, and says why', () => {
    const ios = route({ ...plain, Context: { platforms: ['ios'] } });
    expect(ios).toMatchObject({ runner: 'e2e', reason: 'e2e: the only runner that can run it' });
    expect(ios.considered).toContainEqual({ name: 'vibium', eligible: false, why: ['runs web, not ios'] });
    const session = route({ ...plain, Context: { session: 'signed-in' } });
    expect(session.runner).toBe('e2e');
    const steps = route({ ...plain, Execution: [{ id: 'e1', use: 'order-api', with: {} }] }, both, new Map(), { plugins: [{ name: 'api', runners: ['vibium'], steps: { 'order-api': () => undefined } }] });
    expect(steps).toMatchObject({ runner: 'vibium' });
    expect(steps.considered).toContainEqual({ name: 'e2e', eligible: false, why: ['no plugin registers step kind "order-api" for it'] });
  });

  it('skips a runner that is not available now', () => {
    const noKey = vibiumAvailability({ model: { provider: 'anthropic', model: 'm' } }, {});
    expect(noKey).toEqual({ ok: false, reason: 'ANTHROPIC_API_KEY is not set for anthropic' });
    expect(vibiumAvailability({ load: async () => ({}) as never }, {})).toEqual({ ok: false, reason: 'no model provider: set model.provider on vibiumRunner, or VIBIUM_AI_PROVIDER' });
    expect(vibiumAvailability({ load: async () => ({}) as never }, { VIBIUM_AI_PROVIDER: 'local', VIBIUM_AI_MODEL: 'qwen' })).toEqual({ ok: true });
    const decision = route({ ...plain, Guardrails: [{ id: 'no-pay', rule: 'Never pay', 'x-deny-requests': ['POST **/pay*'] }] }, [e2e, { ...vibium, availability: noKey }]);
    expect(decision).toMatchObject({ runner: 'e2e', reason: 'e2e: the only runner that can run it' });
    expect(decision.considered).toContainEqual({ name: 'vibium', eligible: false, why: ['not available: ANTHROPIC_API_KEY is not set for anthropic'] });
  });

  it('refuses a case no runner can run, naming every reason', () => {
    const decision = route({ ...plain, Context: { platforms: ['ios'] } }, [{ ...e2e, availability: { ok: false, reason: 'e2e is not installed: npm i -D e2e' } }, vibium]);
    expect(decision.runner).toBeUndefined();
    expect(decision.reason).toBe('no runner can run it: e2e not available: e2e is not installed: npm i -D e2e. vibium runs web, not ios');
  });

  it('demotes a runner that failed as infrastructure on its last run of the case', () => {
    const decision = route(plain, both, past('plain', 'e2e', { failureType: 'infrastructure' }));
    expect(decision).toMatchObject({ runner: 'vibium', reason: 'vibium: e2e failed as infrastructure on its last run of the case (2026-11-18)' });
  });

  it('prefers a deterministic replay of a passing run, then auto.prefer', () => {
    const replay = route(plain, [vibium, e2e], past('plain', 'e2e', { result: 'pass' }), { auto: { prefer: ['vibium', 'e2e'] } });
    expect(replay).toMatchObject({ runner: 'e2e', reason: 'e2e: replays its last passing run of the case, with no model calls' });
    expect(route(plain)).toMatchObject({ runner: 'e2e', reason: 'e2e: first in auto.prefer among equals (e2e, vibium)' });
    expect(route(plain, both, new Map(), { auto: { prefer: ['vibium'] } })).toMatchObject({ runner: 'vibium' });
  });

  it('routes each variant on its own platforms', () => {
    const decision = routeCase(
      { ...parseCige(plain), variant: 'mobile', context: { ...parseCige(plain).context, platforms: ['android'] } },
      both,
      new Map(),
      {},
    );
    expect(decision.runner).toBe('e2e');
  });
});
