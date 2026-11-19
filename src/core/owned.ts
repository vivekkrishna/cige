/**
 * The owned loop: `cige run` for a runner with no test runner of its own
 * (Vibium). It does what a hosted runner's test runner does for e2e: picks
 * the cases (ids, tags, `--last-failed`), runs each resolved case in its own
 * session with retries across a pool of workers, and writes the summaries
 * through the same writer the e2e reporter uses, so a summary reads the same
 * whichever runner produced it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CASES, type CigeConfig, type CigeEnvironment } from './config.ts';
import type { CigeRunner, CigeRunnerSelection, CigeSessionArtifacts } from './contract.ts';
import { codedError, isCigeError, messageOf, signalsForCode } from './errors.ts';
import { executePlan, missingHooks } from './execute.ts';
import { loadCigeCases } from './load.ts';
import { opId, type CigeOp } from './plan.ts';
import { missingStepKinds, pluginProblems } from './plugins.ts';
import type { CigeRunRecord } from './record.ts';
import { fileSafe } from './refs.ts';
import { CigeValidationError, type CigeCase } from './schema.ts';
import type { CigeFailure, CigeOutcome } from './signals.ts';
import { SUMMARY_SUFFIX, summaryRunner, writeSummaries, type CigeRunSummary, type CigeSummaryCounts } from './summary.ts';
import { tagsOf } from './tags.ts';
import { expandVariants } from './variants.ts';

export interface RunCasesOptions<Fixtures = unknown> {
  readonly config: CigeConfig<Fixtures>;
  /** The config file's directory: globs resolve against it unless the config sets `root`. */
  readonly configDir: string;
  readonly runner: CigeRunner;
  /** Absolute: where summaries and recordings go. */
  readonly outputDir: string;
  /** Absolute: what summary paths are relative to. */
  readonly projectRoot: string;
  /** Case ids, or `<id>/<variant>`, to run; default all. */
  readonly ids?: readonly string[];
  /** Run only resolved cases carrying any of these tags (`cige:<id>`, `cige:<id>/<variant>`). */
  readonly tags?: readonly string[];
  /** Only this variant of the selected cases. */
  readonly variant?: string;
  /** Rerun only the cases this runner's last summaries record as failed. */
  readonly lastFailed?: boolean;
  /** Retries after a failed attempt; default 0. */
  readonly retries?: number;
  /** Cases run at once; default 1, since hooks often share state. */
  readonly workers?: number;
  /**
   * End each summary name in the runner's: a matrix run, or cases run on a
   * runner other than their default, so they never overwrite the default
   * runner's summaries.
   */
  readonly suffix?: boolean;
  /** The environment to run in, in place of each case's own (`cige replay --env`). */
  readonly environment?: string;
  /** How `auto` picked this runner, by base name (`<id>` or `<id>.<variant>`): recorded in each summary. */
  readonly selections?: ReadonlyMap<string, CigeRunnerSelection>;
  /** Where progress lines go. */
  readonly log?: (line: string) => void;
}

export interface RunCasesResult {
  readonly exitCode: number;
  readonly counts: CigeSummaryCounts;
  readonly rows: readonly { label: string; text: string }[];
  readonly summaries: readonly CigeRunSummary[];
}

/** A resolved case and the name its summary goes under. */
interface Planned {
  readonly testCase: CigeCase;
  readonly base: string;
  readonly name: string;
}

/** The base names (`<id>` or `<id>.<variant>`) of this runner's summaries that record a failure. */
function lastFailures(outputDir: string, runner: string): Set<string> {
  const failed = new Set<string>();
  if (!existsSync(outputDir)) return failed;
  for (const file of readdirSync(outputDir)) {
    if (!file.endsWith(SUMMARY_SUFFIX)) continue;
    const target = path.join(outputDir, file);
    if (summaryRunner(target) !== runner) continue;
    try {
      const summary = JSON.parse(readFileSync(target, 'utf8')) as Partial<CigeRunSummary>;
      if (summary.result === 'fail' && typeof summary.testId === 'string') failed.add(summary.variant === undefined ? summary.testId : `${summary.testId}.${summary.variant}`);
    } catch {
      // Not a summary this run can read.
    }
  }
  return failed;
}

/** What a throw out of the plan means, given the operation it came from. */
function failureFrom(cause: unknown, op: CigeOp | undefined): CigeFailure {
  const where = { phase: op?.phase ?? 'precondition', ...(op === undefined || opId(op) === undefined ? {} : { failedStep: opId(op)! }) } as const;
  if (isCigeError(cause)) return { ...where, signals: cause.signals, code: cause.code, message: cause.message };
  const coded = codedError(cause);
  if (coded !== undefined) return { ...where, signals: signalsForCode(coded.code, op), code: coded.code, message: coded.message };
  return { ...where, signals: [], code: 'RUNNER_ERROR', message: messageOf(cause) };
}

/** Runs `tasks` with at most `limit` at once, in order of start. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await task(item);
    }
  });
  await Promise.all(lanes);
}

/** Every problem that stops the cases from running on this runner, before any runs: the checks `cigeSuite` makes at collection. */
function loadProblems<Fixtures>(cases: readonly CigeCase[], config: CigeConfig<Fixtures>, runner: string): string[] {
  const plugins = config.plugins ?? [];
  const problems = pluginProblems(plugins).map((problem) => `the CIGE config: ${problem}`);
  const titles = new Map<string, string>();
  for (const testCase of cases) {
    const source = testCase.file ?? testCase.id;
    const other = titles.get(testCase.intent.statement);
    if (other !== undefined) problems.push(`${source}: Intent "${testCase.intent.statement}" is also the Intent of "${other}"; one Intent is one test`);
    titles.set(testCase.intent.statement, testCase.id);
    for (const name of missingHooks(testCase, config.hooks ?? {})) problems.push(`${source}: hook "${name}" is named by the case but not passed in hooks`);
    for (const kind of missingStepKinds(testCase, plugins, runner)) problems.push(`${source}: step kind "${kind}" is used by the case but no plugin registers it for ${runner}`);
    const environment = testCase.context.environment;
    if (config.environments !== undefined && environment !== undefined && !Object.hasOwn(config.environments, environment)) {
      problems.push(`${source}: Context.environment "${environment}" is not one of the config's environments (${Object.keys(config.environments).join(', ') || 'none'})`);
    }
  }
  return problems;
}

/** Runs the selected cases on an owned runner and writes their summaries. */
export async function runCases<Fixtures>(options: RunCasesOptions<Fixtures>): Promise<RunCasesResult> {
  const { config, runner, outputDir } = options;
  const log = options.log ?? (() => undefined);
  if (runner.start === undefined) throw new Error(`runner "${runner.name}" is hosted: run its cases with its own test runner`);
  const cases = loadCigeCases(config.cases ?? DEFAULT_CASES, { root: config.root ?? options.configDir });
  const problems = loadProblems(cases, config, runner.name);
  if (problems.length > 0) throw new CigeValidationError('the CIGE cases', problems);

  const suffix = options.suffix === true ? `.${runner.name}` : '';
  const all: Planned[] = cases.flatMap((testCase) =>
    expandVariants(testCase).map((resolved) => {
      const base = resolved.variant === undefined ? resolved.id : `${resolved.id}.${resolved.variant}`;
      return { testCase: resolved, base, name: `${base}${suffix}` };
    }),
  );
  const failedBefore = options.lastFailed === true ? lastFailures(outputDir, runner.name) : undefined;
  const ids = options.ids ?? [];
  const selected = all.filter(({ testCase, base }) => {
    if (ids.length > 0 && !ids.some((id) => id === testCase.id || id === `${testCase.id}/${testCase.variant}`)) return false;
    if (options.variant !== undefined && testCase.variant !== options.variant) return false;
    if (options.tags !== undefined && options.tags.length > 0 && !tagsOf(testCase.id, testCase.variant).some((tag) => options.tags!.includes(tag))) return false;
    if (failedBefore !== undefined && !failedBefore.has(base)) return false;
    return true;
  });
  if (failedBefore !== undefined && failedBefore.size === 0) log(`cige: no ${runner.name} failures to rerun\n`);
  const partial = selected.length < all.length;
  const runDate = new Date().toISOString().slice(0, 10);
  const plugins = config.plugins ?? [];
  const hooks = config.hooks ?? {};
  const retries = Math.max(0, options.retries ?? 0);
  const records = new Map<string, CigeRunRecord>();
  const fromRoot = (file: string): string => (path.isAbsolute(file) ? path.relative(options.projectRoot, file).split(path.sep).join('/') : file);

  await pool(selected, options.workers ?? 1, async ({ testCase, name }) => {
    const environmentName = options.environment ?? testCase.context.environment;
    const declared: CigeEnvironment | undefined =
      environmentName !== undefined && config.environments !== undefined && Object.hasOwn(config.environments, environmentName) ? config.environments[environmentName] : undefined;
    const environment = { ...(environmentName === undefined ? {} : { name: environmentName }), ...(declared?.baseURL === undefined ? {} : { baseURL: declared.baseURL }) };
    const platforms = testCase.context.platforms;
    if (platforms !== undefined && !runner.capabilities.platforms.includes('*') && !platforms.some((platform) => runner.capabilities.platforms.includes(platform))) {
      // Like a target that doesn't match: the case is skipped here, not failed.
      records.set(name, recordOf(testCase, name, { result: 'skipped', status: 'skipped' }, 0, undefined, environmentName, undefined));
      log(`cige: ${name} skipped: ${runner.name} runs ${runner.capabilities.platforms.join(', ')}, the case ${platforms.join(', ')}\n`);
      return;
    }
    const attempts: { failure?: CigeFailure; artifacts?: CigeSessionArtifacts }[] = [];
    let outcome: CigeOutcome | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let current: CigeOp | undefined;
      let failure: CigeFailure | undefined;
      let artifacts: CigeSessionArtifacts | undefined;
      try {
        const session = await runner.start!({ testCase, environment, plugins, outputDir, name: fileSafe(name), attempt });
        try {
          await executePlan(testCase, session, { hooks: hooks as never, plugins, onOp: (op) => (current = op) });
        } catch (cause) {
          failure = failureFrom(cause, current);
        } finally {
          artifacts = await session.stop?.().catch(() => undefined);
        }
      } catch (cause) {
        // The session never started: the environment, not the case.
        failure = failureFrom(cause, undefined);
      }
      attempts.push({ ...(failure === undefined ? {} : { failure }), ...(artifacts === undefined ? {} : { artifacts }) });
      if (failure === undefined) {
        outcome = { result: 'pass', status: attempt === 0 ? 'passed' : 'flaky' };
        break;
      }
      outcome = { result: 'fail', status: 'failed', failure };
      if (attempt < retries) log(`cige: ${name} failed (${failure.code ?? 'error'}), retrying\n`);
    }
    const last = attempts.at(-1)?.artifacts;
    records.set(name, recordOf(testCase, name, outcome!, attempts.length, last, environmentName, { attempts: attempts.map((entry) => ({ failure: entry.failure, native: entry.artifacts?.native })) }));
    log(`cige: ${name} ${outcome!.result}\n`);
  });

  function recordOf(testCase: CigeCase, name: string, outcome: CigeOutcome, attempts: number, artifacts: CigeSessionArtifacts | undefined, environment: string | undefined, native: unknown): CigeRunRecord {
    const agent = testCase.context.agent;
    const recording = artifacts?.recording === undefined ? undefined : fromRoot(artifacts.recording);
    const selected = options.selections?.get(testCase.variant === undefined ? testCase.id : `${testCase.id}.${testCase.variant}`);
    return {
      key: { id: testCase.id, ...(testCase.variant === undefined ? {} : { variant: testCase.variant }) },
      name,
      runner: { name: runner.name, version: runner.version, ...(selected === undefined ? {} : { selected }) },
      testCase,
      outcome,
      runDate,
      target: environment ?? 'default',
      agent: typeof agent === 'string' ? agent : (agent?.[0] ?? 'default'),
      attempts,
      carried: false,
      narrow: [],
      evidence: {
        resultId: `${runner.name}:${name}:${attempts}`,
        artifacts: [...(recording === undefined ? [] : [recording]), ...(artifacts?.artifacts ?? []).map(fromRoot)],
        ...(recording === undefined ? {} : { recording }),
        ...(artifacts?.groups === undefined ? {} : { groups: artifacts.groups }),
      },
      ...(native === undefined ? {} : { native }),
    };
  }

  // In selection order, not finishing order, so a summary set reads the same run to run.
  const ordered = selected.flatMap(({ name }) => records.get(name) ?? []);
  const ranIds = new Set(selected.map(({ testCase }) => testCase.id));
  const { counts, rows, summaries } = writeSummaries({
    config,
    outputDir,
    projectRoot: options.projectRoot,
    runner: runner.name,
    records: ordered,
    ran: selected.map(({ base }) => base),
    known: all.map(({ base }) => base),
    partial,
    ranCases: cases.filter((testCase) => ranIds.has(testCase.id)),
  });
  return { exitCode: counts.fail > 0 ? 1 : 0, counts, rows: rows ?? [], summaries };
}
