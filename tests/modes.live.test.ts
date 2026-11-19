/**
 * Every runner mode with a real model and real browsers, through the built
 * `cige` command: e2e alone (its web engine), Vibium alone, both in a matrix,
 * and `auto`. One local shop, three cases:
 *
 * - `home`: holds, so it passes everywhere;
 * - `total`: the cart total is wrong, a product defect everywhere;
 * - `pay`: its guardrail is a request rule only Vibium enforces. e2e can only
 *   advise it, so the payment goes through; Vibium blocks it as a violation.
 *   `auto` sends it to Vibium for that reason.
 *
 * Skipped unless CIGE_LIVE=1 with ANTHROPIC_API_KEY set. It costs model
 * calls and, the first time, a Chromium download for the web engine.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CigeRunSummary } from '../src/core/summary.ts';

const LIVE = process.env.CIGE_LIVE === '1' && (process.env.ANTHROPIC_API_KEY ?? '') !== '';
const MODEL = process.env.CIGE_LIVE_MODEL ?? 'claude-sonnet-5-5';
const PROJECT = fileURLToPath(new URL('./tmp-projects/live-modes/', import.meta.url));
const OUT = path.join(PROJECT, '.e2e', 'cige');
const BIN = fileURLToPath(new URL('../dist/cli/bin.js', import.meta.url));

const HOME = `<!doctype html><meta charset="utf-8"><title>Bean Shop</title><h1>Bean Shop</h1>
<p><a href="/cart">View cart</a></p>
<ul><li>House coffee: <strong>$10.00</strong></li></ul>
<button id="pay" onclick="fetch('/api/payments', { method: 'POST', body: '{}' }).then((r) => { if (!r.ok) throw new Error(); document.querySelector('#status').textContent = 'Payment sent'; }).catch(() => (document.querySelector('#status').textContent = 'Payment failed'))">Pay now</button>
<p id="status"></p>`;
const CART = `<!doctype html><meta charset="utf-8"><title>Your cart</title><h1>Your cart</h1>
<p>1 × House coffee ($10.00)</p><p>Total: <strong>$20.00</strong></p>`;

const E2E_CONFIG = `import { anthropic } from '@ai-sdk/anthropic';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { cige } from 'e2e-cige';
import cigeConfig from './cige.config.ts';

export default {
  projectId: 'cige-live-modes',
  targets: [{ name: 'web', engine: web(), app: { url: process.env.CIGE_LIVE_URL! } }],
  workers: 1,
  retries: 0,
  agents: { default: { model: anthropic(${JSON.stringify(MODEL)}) } },
  reporters: [cige(cigeConfig)],
} satisfies E2EConfig;
`;

const CIGE_CONFIG = `import { defineCige } from 'e2e-cige';
import { e2eRunner } from 'e2e-cige/e2e';
import { vibiumRunner } from 'e2e-cige/vibium';

export default defineCige({
  cases: 'cases/*.cige.json',
  root: new URL('.', import.meta.url),
  environments: { shop: { baseURL: process.env.CIGE_LIVE_URL!, reset: () => undefined } },
  runners: { e2e: e2eRunner(), vibium: vibiumRunner({ model: { provider: 'anthropic', model: ${JSON.stringify(MODEL)} } }) },
});
`;

const SUITE = `import { cigeSuite } from 'e2e-cige';
import config from '../cige.config.ts';

cigeSuite(config);
`;

const CASES = {
  home: {
    id: 'home',
    Context: { system: 'Bean Shop', environment: 'shop', open: '/', specRef: 'specs/shop.md', buildRef: 'CHANGELOG.md' },
    Intent: { statement: 'A visitor sees the house coffee for sale with its price', evidence: ['the page lists House coffee at $10.00'] },
    Execution: [{ id: 'e1', step: 'look at the product list' }],
  },
  total: {
    id: 'total',
    Context: { system: 'Bean Shop', environment: 'shop', open: '/', specRef: 'specs/shop.md', buildRef: 'CHANGELOG.md' },
    Intent: { statement: 'The cart total equals the price of its one item', success: ['The total shown is $10.00'] },
    // A step the page allows, with no check in it: judging the total is the Intent's job.
    Execution: [{ id: 'e1', step: 'open the cart with the View cart link' }],
  },
  pay: {
    id: 'pay',
    Context: { system: 'Bean Shop', environment: 'shop', open: '/', facts: ['This is a test shop: pressing Pay now is expected and safe'], specRef: 'specs/shop.md', buildRef: 'CHANGELOG.md' },
    Intent: { statement: 'A visitor can complete checkout with Pay now', success: ['The page says Payment sent'] },
    Guardrails: [{ id: 'sandbox-payments', rule: 'Stay on the Bean Shop site', 'x-deny-requests': ['POST **/api/payments*'] }],
    Execution: [{ id: 'e1', step: 'press the Pay now button' }],
  },
};

let server: http.Server;
let payments = 0;

/** Runs the command without blocking this process: the shop it tests is served from here. */
function cli(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: PROJECT, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => {
      process.stderr.write(`\n$ cige ${args.join(' ')} -> ${status}\n${stderr.split('\n').filter((line) => line.startsWith('cige:')).join('\n')}\n`);
      resolve({ status, stdout, stderr });
    });
  });
}

function files(): Record<string, CigeRunSummary> {
  return Object.fromEntries(
    readdirSync(OUT)
      .filter((file) => file.endsWith('.run-summary.json'))
      .map((file) => [file.slice(0, -'.run-summary.json'.length), JSON.parse(readFileSync(path.join(OUT, file), 'utf8')) as CigeRunSummary]),
  );
}

const verdict = (summary: CigeRunSummary | undefined) => ({
  result: summary?.result,
  failedStep: summary?.failedStep,
  failureType: summary?.failureType,
  runner: summary?.runner?.name,
  signals: summary?.classification.signals.filter((signal) => signal.startsWith('guardrail-')),
});

describe.skipIf(!LIVE)('every runner mode, live', () => {
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url?.startsWith('/api/payments')) {
        payments += 1;
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(request.url?.startsWith('/cart') ? CART : HOME);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.CIGE_LIVE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    rmSync(PROJECT, { recursive: true, force: true });
    mkdirSync(path.join(PROJECT, 'cases'), { recursive: true });
    mkdirSync(path.join(PROJECT, 'tests'), { recursive: true });
    writeFileSync(path.join(PROJECT, 'e2e.config.ts'), E2E_CONFIG);
    writeFileSync(path.join(PROJECT, 'cige.config.ts'), CIGE_CONFIG);
    writeFileSync(path.join(PROJECT, 'tests', 'cige.e2e.ts'), SUITE);
    for (const [name, testCase] of Object.entries(CASES)) writeFileSync(path.join(PROJECT, 'cases', `${name}.cige.json`), JSON.stringify(testCase, null, 2));
  });

  afterAll(() => {
    server?.close();
    if (process.env.CIGE_KEEP_TMP !== '1') rmSync(PROJECT, { recursive: true, force: true });
  });

  it('e2e: passes the home page, calls the wrong total a defect, and only advises the payment rule', async () => {
    const before = payments;
    const run = await cli('run', '--runner', 'e2e');
    expect(run.status).not.toBe(0);
    const now = files();
    expect(verdict(now.home)).toMatchObject({ result: 'pass', runner: 'e2e' });
    expect(verdict(now.total)).toMatchObject({ result: 'fail', failureType: 'product-defect', runner: 'e2e' });
    // Advisory on e2e: nothing stops the request, so the payment reaches the shop.
    expect(verdict(now.pay)).toMatchObject({ result: 'pass', runner: 'e2e' });
    expect(payments).toBe(before + 1);
  }, 900_000);

  it('vibium: the same verdicts, but the payment request is blocked as a violation', async () => {
    const before = payments;
    const run = await cli('run', '--runner', 'vibium');
    expect(run.status).toBe(1);
    const now = files();
    expect(verdict(now['home.vibium'])).toMatchObject({ result: 'pass', runner: 'vibium' });
    expect(verdict(now['total.vibium'])).toMatchObject({ result: 'fail', failedStep: 'intent', failureType: 'product-defect', runner: 'vibium' });
    expect(verdict(now['pay.vibium'])).toMatchObject({ result: 'fail', failedStep: 'e1', runner: 'vibium', signals: ['guardrail-violation:sandbox-payments'] });
    expect(payments).toBe(before);
  }, 900_000);

  it('matrix: both runners side by side, agreeing on the page and the total, and apart on the payment', async () => {
    const before = payments;
    const run = await cli('run', '--runner', 'e2e,vibium');
    expect(run.status).not.toBe(0);
    const now = files();
    for (const id of ['home', 'total']) expect(verdict(now[`${id}.e2e`]).result).toBe(verdict(now[`${id}.vibium`]).result);
    expect(verdict(now['total.e2e'])).toMatchObject({ failureType: 'product-defect' });
    expect(verdict(now['total.vibium'])).toMatchObject({ failureType: 'product-defect' });
    expect(verdict(now['pay.e2e']).result).toBe('pass');
    expect(verdict(now['pay.vibium']).signals).toEqual(['guardrail-violation:sandbox-payments']);
    expect(payments).toBe(before + 1);
  }, 900_000);

  it('auto: sends the payment case to the runner that enforces its rule, and says why', async () => {
    const dry = await cli('run', '--runner', 'auto', '--dry-run');
    expect(dry.status).toBe(0);
    const routes = Object.fromEntries(dry.stdout.trim().split('\n').slice(1).map((line) => line.split('\t')).map(([id, runner, why]) => [id, { runner, why }]));
    expect(routes.pay).toEqual({ runner: 'vibium', why: 'vibium: enforces every guardrail; e2e would only advise sandbox-payments (x-deny-requests)' });
    expect(routes.home).toEqual({ runner: 'e2e', why: 'e2e: replays its last passing run of the case, with no model calls' });
    expect(routes.total?.runner).toBe('e2e');

    const before = payments;
    const run = await cli('run', '--runner', 'auto');
    expect(run.status).not.toBe(0);
    const now = files();
    expect(verdict(now.home)).toMatchObject({ result: 'pass', runner: 'e2e' });
    expect(now.home?.runner?.selected?.reason).toBe(routes.home!.why);
    expect(verdict(now.total)).toMatchObject({ result: 'fail', failureType: 'product-defect', runner: 'e2e' });
    expect(verdict(now.pay)).toMatchObject({ result: 'fail', runner: 'vibium', signals: ['guardrail-violation:sandbox-payments'] });
    expect(now.pay?.runner?.selected?.reason).toBe(routes.pay!.why);
    expect(now.pay?.replay.command).toBe('npx cige replay pay --runner vibium');
    expect(payments).toBe(before);
  }, 900_000);
});
