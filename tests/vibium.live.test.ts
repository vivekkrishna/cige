/**
 * The Vibium adapter against real Vibium: a real browser, a real model, and
 * a local shop page. Skipped unless CIGE_VIBIUM_LIVE=1, with Vibium's own
 * model settings in the environment, for example:
 *
 *   CIGE_VIBIUM_LIVE=1 VIBIUM_AI_PROVIDER=anthropic VIBIUM_AI_MODEL=<model> \
 *     ANTHROPIC_API_KEY=... npx vitest run tests/vibium.live.test.ts
 *
 * It costs model calls, so it is never part of the default run.
 */

import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { vibiumRunner } from '../src/adapters/vibium/runner.ts';
import { runCases } from '../src/core/owned.ts';
import type { CigeTestCase } from '../src/core/schema.ts';
import type { CigeRunSummary } from '../src/core/summary.ts';

const LIVE = process.env.CIGE_VIBIUM_LIVE === '1';

const HOME = `<!doctype html><meta charset="utf-8"><title>Bean Shop</title><h1>Bean Shop</h1>
<p><a href="/cart">View cart</a></p>
<ul><li>House coffee: <strong>$10.00</strong></li></ul>
<button id="pay" onclick="fetch('/api/payments', { method: 'POST', body: '{}' }).then(() => (document.querySelector('#status').textContent = 'Payment sent'), () => (document.querySelector('#status').textContent = 'Payment failed'))">Pay now</button>
<p id="status"></p>`;
// The defect: one $10.00 item, and a total of $20.00.
const CART = `<!doctype html><meta charset="utf-8"><title>Your cart</title><h1>Your cart</h1>
<p>1 × House coffee ($10.00)</p><p>Total: <strong>$20.00</strong></p>`;

const CASES: Record<string, CigeTestCase> = {
  home: {
    id: 'live-home',
    Context: { system: 'Bean Shop', open: '/' },
    Intent: { statement: 'A visitor sees the house coffee for sale with its price', evidence: ['the page lists House coffee at $10.00'] },
    Execution: [{ id: 'e1', step: 'look at the product list' }],
  },
  total: {
    id: 'live-total',
    Context: { system: 'Bean Shop', open: '/' },
    Intent: { statement: 'The cart total equals the price of its one item', success: ['The total shown is $10.00'] },
    // A step the page allows, with no check in it: judging the total is the Intent's job.
    Execution: [{ id: 'e1', step: 'open the cart with the View cart link' }],
  },
  deny: {
    id: 'live-deny',
    Context: { system: 'Bean Shop', open: '/' },
    Intent: 'A visitor can pay for the house coffee',
    Guardrails: [{ id: 'no-pay', rule: 'A payment request must never reach the payments API in this test', 'x-deny-requests': ['POST **/api/payments*'] }],
    Execution: [{ id: 'e1', step: 'press the Pay now button' }],
  },
  // The rule's prose gives the agent no reason to hold back, so only the route can stop the request.
  enforced: {
    id: 'live-enforced',
    Context: { system: 'Bean Shop', open: '/', facts: ['This is a test shop: pressing Pay now is expected and safe'] },
    Intent: 'A visitor can complete checkout with Pay now',
    Guardrails: [{ id: 'sandbox-payments', rule: 'Stay on the Bean Shop site', 'x-deny-requests': ['POST **/api/payments*'] }],
    Execution: [{ id: 'e1', step: 'press the Pay now button' }],
  },
};

let server: http.Server;
let payments = 0;
let summaries: Record<string, CigeRunSummary> = {};
let dir: string;

describe.skipIf(!LIVE)('Vibium, live', () => {
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url?.startsWith('/api/payments')) {
        payments += 1;
        response.end('{"ok":true}');
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(request.url?.startsWith('/cart') ? CART : HOME);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(tmpdir(), 'cige-live-'));
    mkdirSync(path.join(dir, 'cases'));
    for (const [name, testCase] of Object.entries(CASES)) writeFileSync(path.join(dir, 'cases', `${name}.cige.json`), JSON.stringify(testCase));
    const result = await runCases({
      config: { cases: 'cases/*.cige.json' },
      configDir: dir,
      projectRoot: dir,
      outputDir: path.join(dir, 'out'),
      runner: vibiumRunner({ baseURL }),
      log: (line) => process.stderr.write(line),
    });
    summaries = Object.fromEntries(result.summaries.map((summary) => [summary.testId, summary]));
  }, 600_000);

  afterAll(() => {
    server?.close();
    if (dir !== undefined && process.env.CIGE_KEEP_TMP !== '1') rmSync(dir, { recursive: true, force: true });
  });

  it('passes a case whose Intent holds, judged on the recording', () => {
    expect(summaries['live-home']).toMatchObject({ result: 'pass', runner: { name: 'vibium' } });
    expect(summaries['live-home']?.evidence.recording).toMatch(/live-home\.attempt-1\.zip$/);
  });

  it('calls a wrong total a product defect, at the Intent', () => {
    expect(summaries['live-total']).toMatchObject({ result: 'fail', failedStep: 'intent', failureType: 'product-defect' });
  });

  it('blocks the request itself when the agent goes ahead, as that guardrail violated', () => {
    expect(summaries['live-enforced']).toMatchObject({
      result: 'fail',
      failedStep: 'e1',
      classification: { errorCode: 'POLICY_DENIED', signals: expect.arrayContaining(['guardrail-violation:sandbox-payments']) },
    });
  });

  it('never lets the denied request reach the server, and fails the step on that guardrail', () => {
    expect(payments).toBe(0);
    const signals = summaries['live-deny']?.classification.signals ?? [];
    // Enforced by the route, or refused by the agent that read the guardrail: either way, on no-pay.
    expect(signals.some((signal) => signal === 'guardrail-violation:no-pay' || signal.startsWith('guardrail-refused'))).toBe(true);
    expect(summaries['live-deny']).toMatchObject({ result: 'fail', failedStep: 'e1' });
  });
});
