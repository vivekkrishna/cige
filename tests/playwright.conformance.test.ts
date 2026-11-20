/**
 * End to end through the built package, on real Playwright Test and
 * Chromium, no model: the conformance scenarios as `*.cige.spec.ts`
 * bindings, each producing its failure the way plain Playwright code does
 * (a click on a button that's gone, an `expect` that never holds, a request
 * a guardrail blocks), run by the `cige` command. The adapter must route
 * every scenario it can produce the way the kit expects, put the CIGE
 * verdict on the error a healer reads, and play its part in a matrix run,
 * replay, check, compile, and healer.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CigeRunSummary } from '../src/core/summary.ts';
import { checkConformance, CONFORMANCE_MARKERS, CONFORMANCE_SCENARIOS } from '../src/runner/conformance.ts';

const PROJECT = fileURLToPath(new URL('./tmp-projects/playwright-conformance/', import.meta.url));
const BIN = fileURLToPath(new URL('../dist/cli/bin.js', import.meta.url));
// Playwright resolves a reporter with require.resolve from the config's directory, which a package's
// self-reference doesn't reach; installed, e2e-cige/playwright/reporter resolves from node_modules.
const REPORTER = fileURLToPath(new URL('../dist/adapters/playwright/reporter.js', import.meta.url));
const OUT = path.join(PROJECT, '.e2e', 'cige');

const CIGE_CONFIG = `import { defineCige } from 'e2e-cige/core';
import { playwrightRunner } from 'e2e-cige/playwright';
import { conformanceHooks, conformancePlugin } from 'e2e-cige/runner';
import { vibiumRunner } from 'e2e-cige/vibium';
import { fakeVibium } from '../../helpers/fake-vibium.ts';

export default defineCige({
  cases: 'cases/*.cige.json',
  root: new URL('.', import.meta.url),
  hooks: conformanceHooks,
  plugins: [conformancePlugin],
  runners: {
    // A scripted judge: the defect scenario's Intent is the one about a discount.
    playwright: playwrightRunner({
      judge: ({ claim }) => (claim.includes(${JSON.stringify(CONFORMANCE_MARKERS.brokenTotal)}) ? { status: 'failed', summary: 'the total shows no discount' } : { status: 'passed' }),
    }),
    vibium: vibiumRunner({ load: async () => fakeVibium().module, version: 'fake-1', model: { provider: 'anthropic' }, available: () => ({ ok: true }) }),
  },
  runner: 'playwright',
});
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';
import cige from './cige.config.ts';

export default defineConfig({
  testDir: 'cases',
  testMatch: '**/*.cige.spec.ts',
  outputDir: 'test-results',
  workers: 2,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 400 },
  use: { actionTimeout: 400, trace: 'retain-on-failure' },
  reporter: [['list'], [${JSON.stringify(REPORTER)}, cige]],
});
`;

/** Each scenario's Execution as plain Playwright code, failing the way such code natively fails. */
const SPEC = `import { expect } from '@playwright/test';
import { cigeTest, type CigeBindingArgs } from 'e2e-cige/playwright';
import config from '../cige.config.ts';

const shop = '<h1>Shop</h1><button>Add to cart</button><span data-testid="count">0</span><button>Pay</button>';
const addOne = async ({ page }: CigeBindingArgs) => {
  await page.setContent(shop);
  await page.evaluate(() => { document.querySelector('[data-testid=count]')!.textContent = '1'; });
};

cigeTest(config, 'pass', {
  e1: addOne,
  e2: async ({ page }) => { await expect(page.getByTestId('count')).toHaveText('1'); },
  e3: async ({ page }) => { await page.getByRole('button', { name: 'Pay' }).click(); },
});

// The Checkout button was renamed: the locator finds nothing.
cigeTest(config, 'stale', {
  e1: addOne,
  e2: async ({ page }) => { await page.getByRole('button', { name: 'Checkout' }).click(); },
});

cigeTest(config, 'defect', { e1: addOne });

cigeTest(config, 'evidence', { e1: addOne });

// The page posts a refund: the guardrail's x-deny-requests blocks it, and the app swallows the error.
cigeTest(config, 'violation', {
  e1: async ({ page }) => {
    await page.setContent('<h1>Order 42</h1>');
    await page.evaluate(() => fetch('http://127.0.0.1:4599/refund?order=42', { method: 'POST' }).catch(() => undefined));
  },
});

// The tab list is there; the Billing tab the step waits for never is.
cigeTest(config, 'unreachable', {
  e1: async ({ page }) => {
    await page.setContent('<div role="tablist"><span role="tab">Profile</span></div>');
    await expect(page.getByRole('tablist')).toContainText('Billing');
  },
});

// Waiting on something that never happens, with no locator to blame: the clock ran out.
cigeTest(config, 'limit', {
  e1: async ({ page }) => {
    await page.setContent('<div class="card">Card</div>');
    await page.waitForEvent('download', { timeout: 300 });
  },
});

cigeTest(config, 'inconclusive', { e1: addOne });

cigeTest(config, 'plugin-step', { e1: async ({ page }) => { await page.setContent('<h1>Orders</h1>'); } });

cigeTest(config, 'infrastructure', { e1: addOne });
`;

/** What Playwright Test can't natively produce, and why: never faked. */
const UNSUPPORTED = {
  refusal: 'Playwright runs bound code: no agent reads a guardrail and stops itself',
  'missing-information': 'Playwright runs bound code: no agent stops to ask for information',
};

const UNBOUND = { id: 'unbound', Context: {}, Intent: 'A shopper can save a cart for later', Execution: [{ id: 'e1', step: 'save the cart' }, { id: 'e2', verify: 'the cart is listed as saved' }] };

function cli(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: PROJECT, encoding: 'utf8', env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' } });
}

function files(): Record<string, CigeRunSummary> {
  return Object.fromEntries(
    readdirSync(OUT)
      .filter((file) => file.endsWith('.run-summary.json'))
      .map((file) => [file.slice(0, -'.run-summary.json'.length), JSON.parse(readFileSync(path.join(OUT, file), 'utf8')) as CigeRunSummary]),
  );
}

function byRunner(summaries: Record<string, CigeRunSummary>, runner: string): Record<string, CigeRunSummary> {
  return Object.fromEntries(Object.values(summaries).filter((summary) => summary.runner?.name === runner).map((summary) => [summary.testId, summary]));
}

let first: ReturnType<typeof cli>;
let afterFirst: Record<string, CigeRunSummary>;

beforeAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(path.join(PROJECT, 'cases'), { recursive: true });
  writeFileSync(path.join(PROJECT, 'cige.config.ts'), CIGE_CONFIG);
  writeFileSync(path.join(PROJECT, 'playwright.config.ts'), PLAYWRIGHT_CONFIG);
  writeFileSync(path.join(PROJECT, 'cases', 'conformance.cige.spec.ts'), SPEC);
  for (const scenario of CONFORMANCE_SCENARIOS) writeFileSync(path.join(PROJECT, 'cases', `${scenario.id}.cige.json`), JSON.stringify(scenario.case, null, 2));
  writeFileSync(path.join(PROJECT, 'cases', 'unbound.cige.json'), JSON.stringify(UNBOUND, null, 2));
  first = cli('run');
  afterFirst = files();
}, 180_000);

afterAll(() => {
  if (process.env.CIGE_KEEP_TMP !== '1') rmSync(PROJECT, { recursive: true, force: true });
});

describe('the conformance scenarios on Playwright Test', () => {
  it('hands the run to playwright test and writes one summary per bound case', () => {
    // Each test is located in the spec that registers it, not in this package.
    expect(first.stdout).toMatch(/cases\/conformance\.cige\.spec\.ts:\d+:\d+ › A shopper can open checkout/);
    expect(first.stdout).not.toMatch(/dist\/adapters\/playwright\/[a-z]+\.js:\d+:\d+ ›/);
    // A failure CIGE raised itself points at the case's cigeTest call in the spec.
    expect(first.stdout).toMatch(/CIGE defect failed[\s\S]*?> *\d+ \| cigeTest\(config, 'defect'/);
    expect(first.stderr).toContain("cige: playwright test --grep @cige(?![\\w:./-])");
    // Playwright's own exit code for failed tests.
    expect(first.status).toBe(1);
    const expected = CONFORMANCE_SCENARIOS.map((scenario) => scenario.id).filter((id) => !Object.hasOwn(UNSUPPORTED, id));
    expect(Object.keys(afterFirst).toSorted()).toEqual(expected.toSorted());
    expect(afterFirst.pass?.runner).toEqual({ name: 'playwright', version: (JSON.parse(readFileSync(new URL('../node_modules/@playwright/test/package.json', import.meta.url), 'utf8')) as { version: string }).version });
  });

  it('routes every scenario it can produce the way the conformance kit expects', () => {
    const report = checkConformance(byRunner(afterFirst, 'playwright'), UNSUPPORTED);
    expect(report.problems).toEqual({});
    expect(report.checked.length).toBe(CONFORMANCE_SCENARIOS.length - Object.keys(UNSUPPORTED).length);
  });

  it("names Playwright's own error in each summary and points at the trace", () => {
    expect(afterFirst.stale).toMatchObject({ classification: { errorCode: 'LOCATOR_NOT_FOUND', phase: 'execution' } });
    expect(afterFirst.stale?.classification.message).toContain("waiting for getByRole('button', { name: 'Checkout' })");
    expect(afterFirst.unreachable).toMatchObject({ classification: { errorCode: 'ASSERTION_FAILED' } });
    expect(afterFirst.violation?.classification.message).toContain('CIGE guardrail no-refund violated by request POST http://127.0.0.1:4599/refund?order=42 (blocked)');
    expect(afterFirst.stale?.evidence.trace).toMatch(/^test-results\/.+\/trace\.zip$/);
  });

  it('puts the CIGE verdict and what a repair may touch on the error a healer reads', () => {
    expect(first.stdout).toContain('CIGE stale failed at step e2: outdated-test-logic. The flow changed under this step: repairing its binding in the .cige.spec.ts file is allowed');
    expect(first.stdout).toContain('CIGE defect failed at step intent: product-defect. The app contradicts the Intent: do not change this test, its expected values, or mark it fixme');
    expect(first.stdout).toContain('Summary: .e2e/cige/defect.run-summary.json');
    expect(first.stdout).toContain('CIGE violation failed at step e1: guardrail no-refund blocked a forbidden request');
    // Playwright's own message comes first, untouched.
    expect(first.stdout).toMatch(/locator\.click: Timeout 400ms exceeded\.[\s\S]*CIGE stale failed/);
  });

  it("replays with Playwright's own command when the config declares no environments", () => {
    expect(afterFirst.pass?.replay.command).toBe("npx playwright test --grep '@cige:pass(?![\\w:./-])' --retries 0");
  });
});

describe('the cige command on Playwright Test', () => {
  it('reports a case no spec binds, and skips Playwright for it in auto', () => {
    const check = cli('check', '--runner', 'playwright', '--warn', '--json');
    expect(check.status).toBe(0);
    const report = JSON.parse(check.stdout) as { results: { id: string; gaps: { kind: string; runner?: string; detail: string }[] }[] };
    const unbound = report.results.find((result) => result.id === 'unbound');
    expect(unbound?.gaps).toContainEqual({ kind: 'runner', runner: 'playwright', detail: expect.stringContaining('no spec binds its steps: write one with npx cige compile unbound') });
    expect(report.results.find((result) => result.id === 'pass')?.gaps.some((gap) => gap.runner === 'playwright')).toBe(false);
    const dry = cli('run', '--runner', 'auto', 'unbound', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).not.toContain('unbound\tplaywright');
  });

  it('compiles stubs for an unbound case, then reports it bound, and the stubs fail until written', () => {
    const compiled = cli('compile', 'unbound');
    expect(compiled.stderr).toBe('');
    expect(compiled.status).toBe(0);
    expect(compiled.stdout).toContain(`wrote ${path.join('cases', 'unbound.cige.spec.ts')}`);
    const spec = readFileSync(path.join(PROJECT, 'cases', 'unbound.cige.spec.ts'), 'utf8');
    expect(spec).toContain("cigeTest(config, 'unbound', {");
    expect(spec).toContain("import config from '../cige.config.ts';");
    expect(spec).toContain('// Step: save the cart');
    expect(spec).toContain('// Verify: the cart is listed as saved');
    const again = cli('compile', 'unbound');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('binds every step of unbound');
    // Without ids, every case no spec binds yet: here the two scenarios Playwright can't produce.
    const rest = cli('compile');
    expect(rest.stdout.trim().split('\n').toSorted()).toEqual([`wrote ${path.join('cases', 'missing-information.cige.spec.ts')}`, `wrote ${path.join('cases', 'refusal.cige.spec.ts')}`]);
    expect(cli('compile').stdout).toContain('every case has a spec');
    for (const id of ['missing-information', 'refusal']) rmSync(path.join(PROJECT, 'cases', `${id}.cige.spec.ts`));
    const replay = cli('replay', 'unbound');
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain("cige: playwright test --grep @cige:unbound(?![\\w:./-]) --retries 0");
    expect(files().unbound).toMatchObject({ result: 'fail', failedStep: 'e1', classification: { errorCode: 'STEP_NOT_COMPILED' } });
    expect(files().unbound?.failureType).toBeUndefined();
  });

  it('replays one case and keeps every other summary', () => {
    const before = files();
    const replay = cli('replay', 'pass');
    expect(replay.status).toBe(0);
    const after = files();
    expect(Object.keys(after).toSorted()).toEqual(Object.keys(before).toSorted());
    expect(after.stale).toEqual(before.stale);
    expect(after.pass?.result).toBe('pass');
  });

  it("runs a matrix with Vibium side by side, each runner's summaries named after it", () => {
    const matrix = cli('run', '--runner', 'playwright,vibium', 'pass', 'defect');
    expect(matrix.status).toBe(1);
    const now = files();
    for (const id of ['pass', 'defect']) {
      expect(now[`${id}.playwright`]?.runner?.name).toBe('playwright');
      expect(now[`${id}.vibium`]?.runner?.name).toBe('vibium');
    }
    // A runner's run replaces its own summaries of the cases it ran, plain or suffixed; others stand.
    expect(now.pass).toBeUndefined();
    expect(now.stale?.runner?.name).toBe('playwright');
    expect([now['defect.playwright']?.failureType, now['defect.vibium']?.failureType]).toEqual(['product-defect', 'product-defect']);
    // No environments declared: Playwright's own command, as e2e's summaries print e2e's.
    expect(now['pass.playwright']?.replay.command).toBe("npx playwright test --grep '@cige:pass(?![\\w:./-])' --retries 0");
  });

  it('adds the CIGE rule to the healer agent once, however often it runs', () => {
    const agents = path.join(PROJECT, '.claude', 'agents');
    mkdirSync(agents, { recursive: true });
    const healer = path.join(agents, 'playwright-test-healer.md');
    writeFileSync(healer, '---\nname: playwright-test-healer\n---\n\nYou are the Playwright Test Healer.\n');
    const once = cli('healer');
    expect(once.status).toBe(0);
    expect(once.stdout).toContain('added the CIGE rule');
    const twice = cli('healer');
    expect(twice.stdout).toContain('already has the CIGE rule');
    const text = readFileSync(healer, 'utf8');
    expect(text.match(/<!-- cige:begin -->/g)?.length).toBe(1);
    expect(text).toContain('You are the Playwright Test Healer.');
    expect(text).toContain('`product-defect`: the app contradicts the Intent. Do not change the test');
    expect(text).toContain('.e2e/cige/<id>.run-summary.json');
  });
});
