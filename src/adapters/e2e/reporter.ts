/**
 * The `cige()` reporter: once e2e's report is written, one neutral run
 * record per CIGE result, handed to the core summary writer, which writes
 * `<output>/cige/<id>.run-summary.json` in the format the `cige` skill
 * reads. Tests run in worker processes and a reporter in the main one, so it
 * reads the case files again rather than anything the run left in memory.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { FinishedRun, Report, Reporter, ReporterSummary, TestFixtures } from 'e2e';

import { DEFAULT_CASES, type CigeConfig } from '../../core/config.ts';
import type { CigeRunnerSelection } from '../../core/contract.ts';
import { loadCigeCases } from '../../core/load.ts';
import type { CigeRunRecord } from '../../core/record.ts';
import type { CigeCase } from '../../core/schema.ts';
import { writeSummaries } from '../../core/summary.ts';
import { CIGE_TAG } from '../../core/tags.ts';
import { caseForVariant } from '../../core/variants.ts';
import { attemptsOf, outcomeOf } from './report.ts';

export type { CigeRunSummary } from '../../core/summary.ts';

type ReportResult = Report['run']['results'][number];

/**
 * The reporter's options: the CIGE config. It reads `cases`, `root` (default
 * the project root), `outputDir`, `build`, `environments`, and `refs`.
 */
export type CigeReporterOptions<Fixtures = TestFixtures> = CigeConfig<Fixtures>;

/**
 * Set by `cige run` when e2e shares the summaries with another runner (a
 * matrix run, or cases whose default runner is another): each summary name
 * gets `.e2e` last, so the runners' summaries sit side by side.
 */
export const RUNNER_SUFFIX_ENV = 'CIGE_RUNNER_SUFFIX';

/**
 * Set by `cige run` when `auto` routed cases to e2e: the path of a JSON file,
 * `{ "cases": { "<id>[.<variant>]": { "runner": "e2e", "reason": "..." } } }`,
 * whose reasons the summaries record.
 */
export const RUNNER_SELECTION_ENV = 'CIGE_RUNNER_SELECTION';

/** The `auto` selections for e2e that `cige run` handed this run, by base name. */
function selectionsFor(): ReadonlyMap<string, CigeRunnerSelection> {
  const file = process.env[RUNNER_SELECTION_ENV];
  if (file === undefined || file === '') return new Map();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cases?: Record<string, { runner?: string; reason?: string }> };
    return new Map(
      Object.entries(parsed.cases ?? {}).flatMap(([name, entry]) =>
        entry.runner === 'e2e' && typeof entry.reason === 'string' ? [[name, { by: 'auto' as const, reason: entry.reason }]] : [],
      ),
    );
  } catch {
    // A selection file that doesn't read changes no verdict; the summaries just don't carry the reason.
    return new Map();
  }
}

/** The case id and variant a result's tags name: `cige:<id>`, and `cige:<id>/<variant>` for a variant. */
function caseOf(result: ReportResult): { readonly id: string; readonly variant?: string } | undefined {
  const prefix = `${CIGE_TAG}:`;
  const id = result.tags.find((name) => name.startsWith(prefix) && !name.includes('/'))?.slice(prefix.length);
  if (id === undefined) return undefined;
  const variant = result.tags.find((name) => name.startsWith(`${prefix}${id}/`))?.slice(prefix.length + id.length + 1);
  return variant === undefined ? { id } : { id, variant };
}

/** What a result's summary files are named after: the case id, and its variant when it has one. */
function summaryNameOf(result: ReportResult): string | undefined {
  const key = caseOf(result);
  return key === undefined ? undefined : key.variant === undefined ? key.id : `${key.id}.${key.variant}`;
}

/** The record of one result; `testCase` is undefined when its file is no longer among the globs. */
function recordOf(
  run: Pick<FinishedRun, 'report' | 'reportPath' | 'projectRoot' | 'artifactsRoot' | 'traces'>,
  result: ReportResult,
  testCase: CigeCase | undefined,
  carried: boolean,
  shared: boolean,
  matrix: boolean,
  selected: CigeRunnerSelection | undefined,
): CigeRunRecord {
  const key = caseOf(result)!;
  const base = summaryNameOf(result)!;
  const fromRoot = (file: string): string => path.relative(run.projectRoot, file).split(path.sep).join('/');
  const attempts = attemptsOf(result, run.report);
  const artifacts = (attempts.at(-1)?.artifacts ?? []).flatMap((artifact) =>
    artifact.path === undefined ? (artifact.url === undefined ? [] : [artifact.url]) : [fromRoot(path.join(run.artifactsRoot, artifact.path))],
  );
  const trace = run.traces.get(result.id);
  // When the case ran more than once (targets, agents), the summary and its replay name the result's own.
  const name = shared ? [base, result.targetId, result.agent, ...(result.repeat === 0 ? [] : [String(result.repeat)])].join('.') : base;
  const title = result.titlePath.at(-1);
  return {
    key,
    name: matrix ? `${name}.e2e` : name,
    runner: { name: 'e2e', version: run.report.run.runner.version, ...(selected === undefined ? {} : { selected }) },
    testCase,
    outcome:
      testCase === undefined
        ? { result: result.status === 'passed' || result.status === 'flaky' ? 'pass' : result.status === 'skipped' || result.status === 'interrupted' ? result.status : 'fail', status: result.status }
        : outcomeOf(testCase, result, run.report),
    ...(title === undefined ? {} : { title }),
    runDate: run.report.run.startedAt.slice(0, 10),
    target: result.targetId,
    agent: result.agent,
    attempts: attempts.length,
    carried,
    narrow: shared ? ['--target', result.targetId, '--agent', result.agent] : [],
    evidence: {
      ...(run.reportPath === undefined ? {} : { report: fromRoot(run.reportPath) }),
      resultId: result.id,
      ...(trace === undefined ? {} : { trace }),
      artifacts,
    },
    native: result,
  };
}

/**
 * The CIGE reporter. Writes `<output>/cige/<id>.run-summary.json` for each
 * CIGE result the run selected (`<id>.<variant>.run-summary.json` for a
 * variant), and for each failure a `--last-failed` rerun carried without
 * running it again; a case that ran on several targets or as several agents
 * gets one file per result, named after both.
 * Summaries an earlier e2e run left there are removed first, unless this run
 * left cases out, whose untouched cases keep theirs. Nothing else in the
 * directory is removed, other runners' summaries included.
 */
export function cige<Fixtures extends TestFixtures = TestFixtures>(options: CigeReporterOptions<Fixtures> = {}): Reporter {
  return {
    name: 'cige',
    async onRunFinished(run): Promise<ReporterSummary | void> {
      if (run.reportPath === undefined) return;
      const outputDir = path.resolve(run.projectRoot, options.outputDir ?? path.join(path.dirname(run.reportPath), 'cige'));
      const isCige = (result: ReportResult): boolean => caseOf(result) !== undefined;
      const selected = run.report.run.results.filter((result) => result.selected && isCige(result));
      const carried = (run.report.run.carried?.results ?? []).filter(isCige);
      const results = [...selected.map((result) => ({ result, carried: false })), ...carried.map((result) => ({ result, carried: true }))];
      const ran = results.map(({ result }) => summaryNameOf(result)!);
      // By summary name, not case id: a run of one variant leaves its siblings out.
      const known = run.report.run.results.flatMap((result) => summaryNameOf(result) ?? []);
      const partial = run.lastRun !== undefined || known.some((name) => !ran.includes(name));
      const cases =
        results.length === 0
          ? new Map<string, CigeCase>()
          : new Map(loadCigeCases(options.cases ?? DEFAULT_CASES, { root: options.root ?? run.projectRoot }).map((testCase) => [testCase.id, testCase]));
      const perCase = new Map<string, number>();
      for (const name of ran) perCase.set(name, (perCase.get(name) ?? 0) + 1);
      const matrix = process.env[RUNNER_SUFFIX_ENV] === '1';
      const selections = selectionsFor();
      const records = results.map(({ result, carried: wasCarried }) => {
        const key = caseOf(result)!;
        const loaded = cases.get(key.id);
        const testCase = loaded === undefined ? undefined : caseForVariant(loaded, key.variant);
        return recordOf(run, result, testCase, wasCarried, perCase.get(summaryNameOf(result)!) !== 1, matrix, selections.get(summaryNameOf(result)!));
      });
      const ranCases = [...new Set(results.map(({ result }) => caseOf(result)!.id))].flatMap((id) => {
        const testCase = cases.get(id);
        return testCase === undefined ? [] : [testCase];
      });
      const { rows } = writeSummaries({ config: options, outputDir, projectRoot: run.projectRoot, runner: 'e2e', records, ran, known, partial, ranCases });
      return rows;
    },
  };
}
