/**
 * The Playwright reporter: once the run ends, one neutral run record per
 * CIGE test, handed to the core summary writer, which writes
 * `<output>/<id>.run-summary.json` in the format the `cige` skill reads,
 * the same as e2e's and Vibium's. Name it in `playwright.config.ts`:
 *
 * ```ts
 * import cige from './cige.config.ts';
 * reporter: [['list'], ['e2e-cige/playwright/reporter', cige]],
 * ```
 *
 * With no options it loads `cige.config.ts` beside the Playwright config.
 * Tests run in worker processes and the reporter in the main one, so what a
 * failure means is read from the test's `cige-outcome` attachment, which the
 * test wrote where the failure happened; a test stopped by its timeout has
 * none, and is read from its steps instead.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FullConfig, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { DEFAULT_CASES, type CigeConfig } from '../../core/config.ts';
import { selectionsFor, suffixRequested } from '../../core/hosted.ts';
import { loadCigeCases } from '../../core/load.ts';
import { planCase } from '../../core/plan.ts';
import type { CigeRunRecord } from '../../core/record.ts';
import type { CigeCase } from '../../core/schema.ts';
import type { CigeFailure, CigeOutcome } from '../../core/signals.ts';
import { writeSummaries } from '../../core/summary.ts';
import { CIGE_TAG } from '../../core/tags.ts';
import { caseForVariant, expandVariants } from '../../core/variants.ts';
import { plainMessage, playwrightFailure } from './errors.ts';
import { DEFAULT_SPECS, rootOf, specsBinding, type PlaywrightRunner } from './runner.ts';
import { opIdOfTitle } from './session.ts';
import { OUTCOME_ATTACHMENT } from './verdict.ts';

const CONFIG_FILES = ['cige.config.ts', 'cige.config.mts', 'cige.config.js', 'cige.config.mjs'];

/** The reporter's options: the CIGE config itself. It reads `cases`, `root`, `outputDir`, `build`, `environments`, `refs`, `plugins`, and `runners`. */
export type CigePlaywrightReporterOptions = CigeConfig<any>;

interface Ran {
  readonly test: TestCase;
  readonly result: TestResult;
}

/** The case id and variant a test's tags name: `@cige:<id>`, and `@cige:<id>/<variant>` for a variant. */
export function caseOfTags(tags: readonly string[]): { readonly id: string; readonly variant?: string } | undefined {
  const prefix = `@${CIGE_TAG}:`;
  const id = tags.find((tag) => tag.startsWith(prefix) && !tag.includes('/'))?.slice(prefix.length);
  if (id === undefined) return undefined;
  const variant = tags.find((tag) => tag.startsWith(`${prefix}${id}/`))?.slice(prefix.length + id.length + 1);
  return variant === undefined ? { id } : { id, variant };
}

function baseOf(key: { readonly id: string; readonly variant?: string }): string {
  return key.variant === undefined ? key.id : `${key.id}.${key.variant}`;
}

/** Playwright's word for a result, as `status:<word>` reads it in the summary. */
function statusOf(result: TestResult): string {
  if (result.status === 'passed') return result.retry > 0 ? 'flaky' : 'passed';
  if (result.status === 'timedOut') return 'timed-out';
  return result.status;
}

/** The last top-level CIGE step of a result that names an operation, and whether it failed. */
function lastCigeStep(result: TestResult): { readonly id: string; readonly failed: boolean } | undefined {
  let last: { id: string; failed: boolean } | undefined;
  for (const step of result.steps) {
    const id = opIdOfTitle(step.title);
    if (id !== undefined) last = { id, failed: step.error !== undefined };
  }
  return last;
}

/**
 * What a failed result means, from the attachment its test wrote, else from
 * its steps and error. A timeout always reads from the steps: the test's own
 * account of a page closed under it is not why it stopped.
 */
export function failureOfResult(testCase: CigeCase, result: TestResult): CigeFailure {
  const message = plainMessage(result.errors[0]?.message ?? result.error?.message ?? '');
  const timedOut = result.status === 'timedOut';
  const attachment = result.attachments.find((entry) => entry.name === OUTCOME_ATTACHMENT && entry.body !== undefined);
  if (attachment !== undefined && !timedOut) {
    try {
      return JSON.parse(attachment.body!.toString('utf8')) as CigeFailure;
    } catch {
      // Unreadable: read it from the steps.
    }
  }
  const step = lastCigeStep(result);
  const op = step === undefined ? undefined : planCase(testCase).find((entry) => 'id' in entry && entry.id === step.id);
  const where = { phase: op?.phase ?? 'precondition', ...(step === undefined ? {} : { failedStep: step.id }) } as const;
  if (timedOut) return { ...where, signals: [{ kind: 'run.stopped' }], code: 'TEST_TIMEOUT', message };
  // A failure before the case's body ran: a fixture, a browser that didn't launch, a beforeEach hook.
  const error = playwrightFailure(Object.assign(new Error(message), { name: 'Error' }), op);
  return { ...where, signals: error.signals, code: error.code, message };
}

/** One result as the neutral outcome the core classifier reads. */
export function outcomeOfResult(testCase: CigeCase | undefined, result: TestResult): CigeOutcome {
  const status = statusOf(result);
  if (result.status === 'passed') return { result: 'pass', status };
  if (result.status === 'skipped') return { result: 'skipped', status };
  if (result.status === 'interrupted') return { result: 'interrupted', status };
  if (testCase === undefined) return { result: 'fail', status };
  return { result: 'fail', status, failure: failureOfResult(testCase, result) };
}

async function loadConfig(options: CigePlaywrightReporterOptions | undefined, projectRoot: string): Promise<{ config: CigeConfig<any>; dir: string }> {
  if (options !== undefined && Object.keys(options).length > 0) return { config: options, dir: projectRoot };
  const file = CONFIG_FILES.map((name) => path.join(projectRoot, name)).find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error(`e2e-cige/playwright/reporter: no CIGE config; pass it as the reporter's options, or put cige.config.ts beside ${projectRoot}`);
  const module = (await import(pathToFileURL(file).href)) as { default?: CigeConfig<any> };
  if (module.default === undefined) throw new Error(`${file} has no default export; export defineCige({...}) from it`);
  return { config: module.default, dir: path.dirname(file) };
}

/**
 * The CIGE reporter for Playwright Test. Writes one summary per CIGE test
 * the run selected (`<id>.<variant>` for a variant; the Playwright project's
 * name added when a case ran in several). A full run removes the summaries
 * an earlier Playwright run left first; a run that left cases out (`--grep`,
 * `--last-failed`) replaces only those it ran. Other runners' summaries are
 * never touched.
 */
export default class CigePlaywrightReporter implements Reporter {
  readonly #options: CigePlaywrightReporterOptions | undefined;
  #config: FullConfig | undefined;
  #selected: TestCase[] = [];
  #startedAt = new Date();
  readonly #results = new Map<string, Ran>();

  constructor(options?: CigePlaywrightReporterOptions) {
    this.#options = options;
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.#config = config;
    this.#startedAt = new Date();
    this.#selected = suite.allTests().filter((test) => caseOfTags(test.tags) !== undefined);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (caseOfTags(test.tags) === undefined) return;
    // A retry ends the same test again: the last attempt is its verdict.
    this.#results.set(test.id, { test, result });
  }

  async onEnd(): Promise<void> {
    if (this.#selected.length === 0) return;
    const full = this.#config!;
    const projectRoot = full.configFile === undefined ? process.cwd() : path.dirname(full.configFile);
    const { config, dir } = await loadConfig(this.#options, projectRoot);
    const root = config.root === undefined ? dir : rootOf(config.root);
    const outputDir = path.resolve(projectRoot, config.outputDir ?? path.join('.e2e', 'cige'));
    const cases = new Map(loadCigeCases(config.cases ?? DEFAULT_CASES, { root }).map((testCase) => [testCase.id, testCase]));
    const runner = config.runners !== undefined && Object.hasOwn(config.runners, 'playwright') ? (config.runners.playwright as PlaywrightRunner) : undefined;
    const specs = runner?.specs ?? DEFAULT_SPECS;

    const perBase = new Map<string, number>();
    for (const test of this.#selected) {
      const base = baseOf(caseOfTags(test.tags)!);
      perBase.set(base, (perBase.get(base) ?? 0) + 1);
    }
    const matrix = suffixRequested();
    const selections = selectionsFor('playwright');
    const fromRoot = (file: string): string => path.relative(projectRoot, file).split(path.sep).join('/');
    const runDate = this.#startedAt.toISOString().slice(0, 10);

    const records: CigeRunRecord[] = this.#selected.map((test) => {
      const key = caseOfTags(test.tags)!;
      const base = baseOf(key);
      const loaded = cases.get(key.id);
      const testCase = loaded === undefined ? undefined : caseForVariant(loaded, key.variant);
      const ran = this.#results.get(test.id);
      const project = test.parent.project()?.name || 'default';
      // A case run in several Playwright projects gets one summary per project.
      const shared = (perBase.get(base) ?? 0) > 1;
      const name = shared ? `${base}.${project}` : base;
      const result = ran?.result;
      const outcome: CigeOutcome = result === undefined ? { result: 'interrupted', status: 'not-run' } : outcomeOfResult(testCase, result);
      const attachments = result?.attachments ?? [];
      const trace = attachments.find((entry) => entry.name === 'trace' && entry.path !== undefined)?.path;
      const artifacts = attachments.flatMap((entry) => (entry.path === undefined || entry.name === 'trace' ? [] : [fromRoot(entry.path)]));
      const selected = selections.get(base);
      return {
        key,
        name: matrix ? `${name}.playwright` : name,
        runner: { name: 'playwright', version: full.version, ...(selected === undefined ? {} : { selected }) },
        testCase,
        outcome,
        title: test.title,
        runDate,
        target: project,
        agent: 'default',
        attempts: result === undefined ? 0 : result.retry + 1,
        carried: false,
        narrow: shared ? ['--project', project] : [],
        evidence: { resultId: test.id, ...(trace === undefined ? {} : { trace: fromRoot(trace) }), artifacts },
        native: result === undefined ? undefined : { status: result.status, retry: result.retry, errors: result.errors.map((error) => plainMessage(error.message ?? '')), annotations: test.annotations },
      };
    });
    const ran = [...new Set(this.#selected.map((test) => baseOf(caseOfTags(test.tags)!)))];
    // What a full Playwright run would run: every resolved case some spec binds.
    const known = [...cases.values()].filter((testCase) => specsBinding(testCase.id, root, specs).length > 0).flatMap((testCase) => expandVariants(testCase).map((resolved) => baseOf({ id: resolved.id, ...(resolved.variant === undefined ? {} : { variant: resolved.variant }) })));
    const partial = known.some((name) => !ran.includes(name));
    const ranCases = [...new Set(this.#selected.map((test) => caseOfTags(test.tags)!.id))].flatMap((id) => cases.get(id) ?? []);
    const { rows } = writeSummaries({ config, outputDir, projectRoot, runner: 'playwright', records, ran, known, partial, ranCases });
    for (const row of rows ?? []) process.stdout.write(`${row.label}: ${row.text}\n`);
  }
}
