/**
 * End to end through the built package: one project of the conformance
 * scenarios, run by the `cige` command on both runners. e2e runs for real
 * (an in-memory engine and a scripted executor, no model); Vibium is the
 * scripted stand-in, loaded through `e2e-cige/vibium`. Both adapters must
 * route every scenario they can produce the way the kit expects, a matrix
 * run must put their summaries side by side, and each runner must clear
 * only its own.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CigeRunSummary } from '../src/core/summary.ts';
import { checkConformance, CONFORMANCE_MARKERS, CONFORMANCE_SCENARIOS } from '../src/runner/conformance.ts';

const PROJECT = fileURLToPath(new URL('./tmp-projects/conformance/', import.meta.url));
const BIN = fileURLToPath(new URL('../dist/cli/bin.js', import.meta.url));
const OUT = path.join(PROJECT, '.e2e', 'cige');

const E2E_CONFIG = `import type { E2EConfig, StepExecutor } from 'e2e';
import { defineEngine } from 'e2e/engine';
import { cige } from 'e2e-cige';
import cigeConfig from './cige.config.ts';

const root = { ref: { id: 'root', revision: '' }, role: 'window' as const, children: [] };
const engine = defineEngine({
  name: 'memory', version: '1.0.0', spiVersion: 1, platform: 'test',
  async observe() { return { location: 'memory://app', root, viewport: { width: 800, height: 600 } }; },
  async locate() { return []; },
});

const M = ${JSON.stringify(CONFORMANCE_MARKERS)};

/** Reports each scenario the way e2e natively does. */
const scripted: StepExecutor = {
  name: 'scripted', version: '1', cache: 'off',
  async runStep(ctx) {
    const text = ctx.step.instruction;
    if (ctx.step.kind === 'assert') return text.includes(M.brokenTotal) ? { status: 'failed', summary: 'the total shows no discount' } : { status: 'passed', summary: 'holds' };
    if (text.startsWith(M.staleTarget)) return { status: 'failed', errorCode: 'LOCATOR_NOT_FOUND', summary: 'there is no such button any more' };
    if (text.startsWith(M.forbiddenRequest)) {
      await ctx.budgets.runTool({ name: 'refund', mutates: true }, async () => 'refunded');
      return { status: 'passed', summary: 'refunded the order' };
    }
    if (text.startsWith(M.refusal)) return { status: 'failed', errorCode: 'POLICY_DENIED', summary: 'deleting is prohibited by no-delete; I did not delete it' };
    if (text.startsWith(M.unreachable)) return { status: 'failed', errorCode: 'ASSERTION_FAILED', summary: 'the wizard has no Billing tab' };
    if (text.startsWith(M.budget)) return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'this engine has no drag verb' };
    return { status: 'passed', summary: 'done' };
  },
};

export default {
  projectId: 'cige-conformance',
  targets: [{ name: 'memory', engine, app: { url: 'http://127.0.0.1:4599' } }],
  workers: 1,
  retries: 0,
  agents: { default: { executor: scripted } },
  reporters: [cige(cigeConfig)],
} satisfies E2EConfig;
`;

const CIGE_CONFIG = `import { writeFileSync } from 'node:fs';
import { defineCige } from 'e2e-cige';
import { e2eRunner } from 'e2e-cige/e2e';
import { conformanceHooks, conformancePlugin } from 'e2e-cige/runner';
import { vibiumRunner } from 'e2e-cige/vibium';
import { fakeVibium } from '../../helpers/fake-vibium.ts';

export default defineCige({
  cases: 'cases/*.cige.json',
  root: new URL('.', import.meta.url),
  hooks: conformanceHooks,
  plugins: [conformancePlugin],
  environments: { memory: { reset: () => writeFileSync(new URL('./reset-ran.txt', import.meta.url), 'memory') } },
  runners: {
    e2e: e2eRunner(),
    // A stand-in needs no model, so it is available whatever the environment holds.
    vibium: vibiumRunner({ load: async () => fakeVibium().module, version: 'fake-1', model: { provider: 'anthropic' }, available: () => ({ ok: true }) }),
  },
});
`;

const SUITE = `import { cigeSuite } from 'e2e-cige';
import config from '../cige.config.ts';

cigeSuite(config);
`;

/** What each runner can't natively produce, and why: never faked. */
const UNSUPPORTED = {
  e2e: { 'missing-information': 'e2e has no verdict for an agent that stops for information the case does not give' },
  vibium: { stale: 'Vibium is agentic on every run: no recorded path or locator can go stale' },
};

function cli(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: PROJECT, encoding: 'utf8', env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' } });
}

/** The summaries on disk, by file stem. */
function files(): Record<string, CigeRunSummary> {
  return Object.fromEntries(
    readdirSync(OUT)
      .filter((file) => file.endsWith('.run-summary.json'))
      .map((file) => [file.slice(0, -'.run-summary.json'.length), JSON.parse(readFileSync(path.join(OUT, file), 'utf8')) as CigeRunSummary]),
  );
}

/** One runner's summaries, by case id. */
function byRunner(summaries: Record<string, CigeRunSummary>, runner: string): Record<string, CigeRunSummary> {
  return Object.fromEntries(Object.values(summaries).filter((summary) => summary.runner?.name === runner).map((summary) => [summary.testId, summary]));
}

let matrix: ReturnType<typeof cli>;
let afterMatrix: Record<string, CigeRunSummary>;

beforeAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(path.join(PROJECT, 'cases'), { recursive: true });
  mkdirSync(path.join(PROJECT, 'tests'), { recursive: true });
  writeFileSync(path.join(PROJECT, 'e2e.config.ts'), E2E_CONFIG);
  writeFileSync(path.join(PROJECT, 'cige.config.ts'), CIGE_CONFIG);
  writeFileSync(path.join(PROJECT, 'tests', 'cige.e2e.ts'), SUITE);
  for (const scenario of CONFORMANCE_SCENARIOS) writeFileSync(path.join(PROJECT, 'cases', `${scenario.id}.cige.json`), JSON.stringify(scenario.case, null, 2));
  matrix = cli('run', '--runner', 'e2e,vibium');
  afterMatrix = files();
}, 180_000);

afterAll(() => {
  if (process.env.CIGE_KEEP_TMP !== '1') rmSync(PROJECT, { recursive: true, force: true });
});

describe('a matrix run on e2e and Vibium', () => {
  it('runs every case on both runners and writes their summaries side by side', () => {
    expect(matrix.stderr).toContain('cige: e2e run --tag cige');
    // e2e's own exit code for failed tests, as replay has always passed it on.
    expect(matrix.status).toBe(3);
    const names = Object.keys(afterMatrix).toSorted();
    expect(names).toEqual(CONFORMANCE_SCENARIOS.flatMap((scenario) => [`${scenario.id}.e2e`, `${scenario.id}.vibium`]).toSorted());
    // The installed e2e's own version, as its report names it.
    expect(afterMatrix['defect.e2e']?.runner).toEqual({ name: 'e2e', version: (JSON.parse(readFileSync(new URL('../node_modules/e2e/package.json', import.meta.url), 'utf8')) as { version: string }).version });
    expect(afterMatrix['defect.vibium']?.runner).toEqual({ name: 'vibium', version: 'fake-1' });
  });

  for (const runner of ['e2e', 'vibium'] as const) {
    it(`routes every scenario ${runner} can produce the way the conformance kit expects`, () => {
      const report = checkConformance(byRunner(afterMatrix, runner), UNSUPPORTED[runner]);
      expect(report.problems).toEqual({});
      expect(report.checked.length).toBe(CONFORMANCE_SCENARIOS.length - 1);
    });
  }

  it('gives both runners the same verdict on every scenario both can produce', () => {
    const e2e = byRunner(afterMatrix, 'e2e');
    const vibium = byRunner(afterMatrix, 'vibium');
    const both = CONFORMANCE_SCENARIOS.map((scenario) => scenario.id).filter((id) => !Object.hasOwn(UNSUPPORTED.e2e, id) && !Object.hasOwn(UNSUPPORTED.vibium, id));
    const verdict = (summary: CigeRunSummary | undefined) => [summary?.result, summary?.failedStep, summary?.failureType ?? null];
    expect(both.map((id) => [id, ...verdict(vibium[id])])).toEqual(both.map((id) => [id, ...verdict(e2e[id])]));
  });

  it('points a Vibium summary at its recording, and replays it on its runner', () => {
    expect(afterMatrix['pass.vibium']).toMatchObject({
      evidence: { recording: '.e2e/cige/recordings/pass.vibium.attempt-1.zip', groups: ['e1', 'e2', 'e3', 'order-record'] },
      replay: { command: 'npx cige replay pass --runner vibium' },
    });
    expect(existsSync(path.join(OUT, 'recordings', 'pass.vibium.attempt-1.zip'))).toBe(true);
    // e2e is this project's default runner, so its replay names none.
    expect(afterMatrix['pass.e2e']?.replay.command).toBe('npx cige replay pass');
  });
});

describe('the cige command across runners', () => {
  it("clears only e2e's summaries on a full e2e run, keeping Vibium's", () => {
    const run = cli('run');
    expect(run.status).toBe(3);
    const now = Object.keys(files());
    for (const scenario of CONFORMANCE_SCENARIOS) {
      expect(now).toContain(scenario.id);
      expect(now).toContain(`${scenario.id}.vibium`);
      expect(now).not.toContain(`${scenario.id}.e2e`);
    }
    expect(files().pass?.replay.command).toBe('npx cige replay pass');
  });

  it('names what each runner cannot do for a case in check', () => {
    const vibium = cli('check', '--runner', 'vibium', '--warn');
    expect(vibium.status).toBe(0);
    expect(vibium.stdout).toContain('runner (vibium): vibium reports no per-action events, so the deny rules of no-refund are advisory');
    const e2e = cli('check', '--runner', 'e2e', '--warn');
    expect(e2e.stdout).toContain("runner (e2e): e2e can't block requests, so the x-deny-requests of no-refund are advisory");
  });

  it('replays one case on Vibium after resetting its environment, beside the default runner', () => {
    rmSync(path.join(PROJECT, 'reset-ran.txt'), { force: true });
    const replay = cli('replay', 'refusal', '--runner', 'vibium', '--env', 'memory');
    expect(replay.stderr).toContain('cige: resetting memory');
    expect(replay.status).toBe(1);
    expect(existsSync(path.join(PROJECT, 'reset-ran.txt'))).toBe(true);
    expect(files()['refusal.vibium']).toMatchObject({ result: 'fail', classification: { signals: expect.arrayContaining(['guardrail-refused:no-delete']) } });
    // Not the default runner's file: e2e's summary of it still stands.
    expect(files().refusal?.runner?.name).toBe('e2e');
  });

  it("rejudges the Intent on the stored recording once it changes, and refuses a run that never reached it", () => {
    const file = path.join(PROJECT, 'cases', 'defect.cige.json');
    const edited = { ...JSON.parse(readFileSync(file, 'utf8')), Intent: 'The total shows the order amount' };
    writeFileSync(file, JSON.stringify(edited, null, 2));
    const rejudged = cli('rejudge', 'defect', '--runner', 'vibium');
    expect(rejudged.stderr).toBe('');
    expect(rejudged.status).toBe(0);
    expect(rejudged.stdout).toContain('defect: fail -> pass');
    expect(files()['defect.vibium']).toMatchObject({
      result: 'pass',
      intent: 'The total shows the order amount',
      rejudged: { previous: 'fail', previousFailureType: 'product-defect' },
      evidence: { recording: '.e2e/cige/recordings/defect.vibium.attempt-1.zip' },
    });
    const early = cli('rejudge', 'unreachable', '--runner', 'vibium');
    expect(early.status).toBe(2);
    expect(early.stderr).toContain('failed at e1, before its Intent was judged; replay it instead');
    const hosted = cli('rejudge', 'pass', '--runner', 'e2e');
    expect(hosted.stderr).toContain("the e2e runner can't judge a stored recording");
  });

  it('runs one case with a tag filter and keeps the rest', () => {
    const before = files();
    const run = cli('run', '--runner', 'vibium', '--tag', 'cige:limit');
    expect(run.status).toBe(1);
    const after = files();
    expect(Object.keys(after).toSorted()).toEqual(Object.keys(before).toSorted());
    expect(after['pass.vibium']).toEqual(before['pass.vibium']);
    expect(after['limit.vibium']).toMatchObject({ classification: { signals: expect.arrayContaining(['automation-limit']) } });
  });
});

describe('auto routing through the cige command', () => {
  const AUTO_CASES = {
    'auto-requests': {
      id: 'auto-requests',
      Context: {},
      Intent: 'A support agent can open a refund request',
      Guardrails: [{ id: 'no-refund', rule: 'Never refund an order', 'x-deny-requests': ['POST **/refund*'] }],
      Execution: [{ id: 'e1', step: 'open the refund request form' }],
    },
    'auto-actions': {
      id: 'auto-actions',
      Context: {},
      Intent: 'A support agent can open an order',
      Guardrails: [{ id: 'no-refund', rule: 'Never refund an order', deny: { actions: ['tool:refund'] } }],
      Execution: [{ id: 'e1', step: 'open the order' }],
    },
  };

  it('prints each case its runner and why on a dry run, and runs nothing', () => {
    for (const [name, testCase] of Object.entries(AUTO_CASES)) writeFileSync(path.join(PROJECT, 'cases', `${name}.cige.json`), JSON.stringify(testCase, null, 2));
    const before = files();
    const dry = cli('run', '--runner', 'auto', 'auto-requests', 'auto-actions', 'pass', 'violation', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout.trim().split('\n')).toEqual([
      // In case-file order, as the cases load.
      'case\trunner\twhy',
      'auto-actions\te2e\te2e: enforces every guardrail; vibium would only advise no-refund (deny)',
      'auto-requests\tvibium\tvibium: enforces every guardrail; e2e would only advise no-refund (x-deny-requests)',
      'pass\te2e\te2e: replays its last passing run of the case, with no model calls',
      // Both deny kinds: each runner advises one, so the tie goes to the deterministic runner first in auto.prefer.
      'violation\te2e\te2e: first in auto.prefer among equals (e2e, vibium)',
    ]);
    expect(files()).toEqual(before);
  });

  it('runs each case on its routed runner and records why in its summary', () => {
    const run = cli('run', '--runner', 'auto', 'auto-requests', 'auto-actions');
    expect(run.stderr).toContain('cige: 1 case run on e2e');
    expect(run.stderr).toContain('cige: 1 case run on vibium');
    expect(run.status).toBe(0);
    const now = files();
    expect(now['auto-requests']).toMatchObject({
      result: 'pass',
      runner: { name: 'vibium', selected: { by: 'auto', reason: 'vibium: enforces every guardrail; e2e would only advise no-refund (x-deny-requests)' } },
      replay: { command: 'npx cige replay auto-requests --runner vibium' },
    });
    // e2e's reporter read the reason from the selection file cige run handed it.
    expect(now['auto-actions']).toMatchObject({
      result: 'pass',
      runner: { name: 'e2e', selected: { by: 'auto', reason: 'e2e: enforces every guardrail; vibium would only advise no-refund (deny)' } },
    });
    expect(Object.keys(now)).not.toContain('auto-requests.vibium');
  });

  it('refuses to start when auto can route no runner for a case', () => {
    writeFileSync(
      path.join(PROJECT, 'cases', 'auto-nowhere.cige.json'),
      JSON.stringify({ id: 'auto-nowhere', Context: {}, Intent: 'The orders API answers on its own', Execution: [{ id: 'e1', use: 'unregistered-kind', with: {} }] }),
    );
    try {
      const run = cli('run', '--runner', 'auto', 'auto-nowhere');
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("auto can't route 1 case, so nothing ran:");
      expect(run.stderr).toContain('auto-nowhere: no runner can run it: e2e no plugin registers step kind "unregistered-kind" for it. vibium no plugin registers step kind "unregistered-kind" for it');
    } finally {
      rmSync(path.join(PROJECT, 'cases', 'auto-nowhere.cige.json'));
    }
  });
});
