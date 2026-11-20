/**
 * The summary writer: one `<id>.run-summary.json` per run record, in the
 * format the `cige` skill reads, whichever runner produced the record. A
 * summary carries pointers, not contents: the report or recording, the
 * trace, the artifacts, the case's `specRef`, `buildRef`, and `expectedRef`
 * with `{build}` and `{environment}` filled in, and the commands that resolve
 * them and replay the case. The classifying agent fetches what it needs,
 * when it needs it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readinessGaps } from './check.ts';
import { classify, type CigeClassification, type CigeFailureType } from './classify.ts';
import { fillRef, type CigeConfig } from './config.ts';
import type { CigeRunnerSelection } from './contract.ts';
import type { AnyPlugin, CigeClassificationChange } from './plugins.ts';
import type { CigeRunRecord } from './record.ts';
import { fileSafe } from './refs.ts';
import type { CigeCase } from './schema.ts';
import { defaultRunnerName } from './select.ts';
import { cigeGrep, cigeTag } from './tags.ts';

/** One CIGE run summary: what the `cige` skill reads before it classifies or repairs anything. */
export interface CigeRunSummary {
  readonly testId: string;
  /** The variant that ran, when the case has variants. */
  readonly variant?: string;
  readonly runDate: string;
  readonly build?: string;
  /** `interrupted`: the run stopped before the test reached a verdict (`--max-failures`, a signal); never triaged. */
  readonly result: 'pass' | 'fail' | 'skipped' | 'interrupted';
  readonly intent: string;
  readonly failedStep?: string;
  readonly failureType?: CigeFailureType;
  readonly classification: {
    readonly source: 'e2e-cige';
    readonly confidence: 'heuristic';
    readonly phase?: CigeClassification['phase'];
    readonly errorCode?: string;
    readonly message?: string;
    readonly signals: readonly string[];
    /** The plugins whose `classify` changed this classification, in config order. */
    readonly adjustedBy?: readonly string[];
  };
  /** The case's top-level `x-` keys, then each plugin's `summarize` fields under its name. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly specRef?: string;
  readonly buildRef?: string;
  readonly expectedRef?: string;
  /** The command that resolves the refs into files beside the summary, when the config has resolvers. */
  readonly resolveRefs?: string;
  /** How to replay this result once a repair is in: the environment it needs, and the command. */
  readonly replay: { readonly environment?: string; readonly command: string };
  readonly case?: string;
  readonly target: string;
  readonly agent: string;
  readonly attempts: number;
  /** The runner that produced the result. */
  readonly runner?: { readonly name: string; readonly version: string; readonly selected?: CigeRunnerSelection };
  readonly evidence: {
    readonly report?: string;
    readonly resultId: string;
    readonly trace?: string;
    readonly artifacts: readonly string[];
    /** A recording an archive judge can read again (`cige rejudge`). */
    readonly recording?: string;
    /** The groups in the recording, one per operation that ran. */
    readonly groups?: readonly string[];
  };
  /** Set by `cige rejudge`: the Intent was judged again on the stored recording. */
  readonly rejudged?: { readonly from: string; readonly previous: CigeRunSummary['result']; readonly previousFailureType?: CigeFailureType };
}

export const SUMMARY_SUFFIX = '.run-summary.json';
const REFS_SUFFIX = '.refs';

/** Shell-quotes one argument when it needs it, so a command in a summary pastes as is. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9._:/=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const FAILURE_TYPES: ReadonlySet<CigeFailureType> = new Set(['infrastructure', 'outdated-test-logic', 'product-defect']);

/** The classification without its failure type, for a plugin that clears it. */
function untyped({ failureType: _cleared, ...rest }: CigeClassification): CigeClassification {
  return rest;
}

/**
 * The first classification after each plugin's `classify`, in config order,
 * and the plugins that changed it. A plugin may set a failure type on a
 * failure only, clear one, and add signals; one that throws adds
 * `plugin-error:<name>` and changes nothing else.
 */
export function adjust(
  first: CigeClassification,
  testCase: CigeCase,
  record: CigeRunRecord,
  plugins: readonly AnyPlugin[],
): { readonly classification: CigeClassification; readonly adjustedBy: readonly string[] } {
  const signals = [...first.signals];
  let failureType = first.failureType;
  const current = (): CigeClassification => ({ ...untyped(first), ...(failureType === undefined ? {} : { failureType }), signals: [...signals] });
  const adjustedBy: string[] = [];
  for (const plugin of plugins) {
    if (plugin.classify === undefined) continue;
    let change: CigeClassificationChange | undefined;
    try {
      change = plugin.classify({ testCase, result: record.native, classification: current(), record });
    } catch {
      signals.push(`plugin-error:${plugin.name}`);
      continue;
    }
    if (change === undefined) continue;
    let changed = false;
    if (change.failureType === null && failureType !== undefined) {
      failureType = undefined;
      changed = true;
    } else if (
      change.failureType !== undefined &&
      change.failureType !== null &&
      change.failureType !== failureType &&
      first.result === 'fail' &&
      FAILURE_TYPES.has(change.failureType)
    ) {
      failureType = change.failureType;
      changed = true;
    }
    // A plugin that only repeats what is there changed nothing, and must not read as a verdict.
    for (const signal of change.signals ?? []) {
      if (signals.includes(signal)) continue;
      signals.push(signal);
      changed = true;
    }
    if (changed) adjustedBy.push(plugin.name);
  }
  return { classification: current(), adjustedBy };
}

export interface SummaryContext<Fixtures = unknown> {
  readonly config: CigeConfig<Fixtures>;
  /** Absolute: where the summaries go. */
  readonly outputDir: string;
  /** Absolute: what paths in a summary are relative to. */
  readonly projectRoot: string;
}

/** The replay command for a record: e2e's own without declared environments, else `cige replay`, naming the runner when it isn't the default. */
function replayOf<Fixtures>(record: CigeRunRecord, context: SummaryContext<Fixtures>): CigeRunSummary['replay'] {
  const { config } = context;
  const { id, variant } = record.key;
  const environment = record.testCase?.context.environment;
  const variantArgs = variant === undefined ? [] : ['--variant', variant];
  // Without it, a summary of a suite on another config file prints commands that find no case.
  const configArgs = config.configFile === undefined ? [] : ['--config', config.configFile];
  const environments = config.environments;
  const declared = environment !== undefined && environments !== undefined && Object.hasOwn(environments, environment) ? environments[environment] : undefined;
  const runnerArgs = record.runner.name === defaultRunnerName(config, declared?.runner) ? [] : ['--runner', record.runner.name];
  if (environments === undefined && record.runner.name === 'e2e') {
    return {
      command: ['npx', 'e2e', 'run', ...(config.e2eConfig === undefined ? [] : ['--config', config.e2eConfig]), '--tag', cigeTag(id, variant), '--no-cache', ...record.narrow]
        .map(shellArg)
        .join(' '),
    };
  }
  if (environments === undefined && record.runner.name === 'playwright') {
    const configured = config.runners !== undefined && Object.hasOwn(config.runners, 'playwright') ? config.runners.playwright : undefined;
    const playwrightConfig = configured !== undefined && 'config' in configured && typeof configured.config === 'string' ? configured.config : undefined;
    return {
      command: ['npx', 'playwright', 'test', ...(playwrightConfig === undefined ? [] : ['--config', playwrightConfig]), '--grep', cigeGrep([cigeTag(id, variant)]), '--retries', '0', ...record.narrow]
        .map(shellArg)
        .join(' '),
    };
  }
  return {
    ...(environments === undefined || environment === undefined ? {} : { environment }),
    command: ['npx', 'cige', 'replay', id, ...variantArgs, ...configArgs, ...runnerArgs, ...(record.narrow.length === 0 ? [] : ['--', ...record.narrow])].map(shellArg).join(' '),
  };
}

/** Builds the summary of one record. */
export function summarize<Fixtures>(record: CigeRunRecord, context: SummaryContext<Fixtures>): CigeRunSummary {
  const { config, outputDir, projectRoot } = context;
  const { testCase } = record;
  const { id, variant } = record.key;
  const { build } = config;
  const fromRoot = (file: string): string => path.relative(projectRoot, file).split(path.sep).join('/');
  const first: CigeClassification = testCase === undefined ? { result: record.outcome.result, signals: ['case-not-found'] } : classify(testCase, record.outcome);
  const plugins = config.plugins ?? [];
  const { classification, adjustedBy } = testCase === undefined ? { classification: first, adjustedBy: [] } : adjust(first, testCase, record, plugins);
  const caseContext = testCase?.context;
  const environment = caseContext?.environment;
  const refs = {
    specRef: fillRef(caseContext?.specRef, { build, environment }),
    buildRef: fillRef(caseContext?.buildRef, { build, environment }),
    expectedRef: fillRef(caseContext?.expectedRef, { build, environment }),
  };
  const signals = [...classification.signals];
  // A resolver stands in for a pointer, the way `cige check` counts it.
  if (classification.result === 'fail' && testCase !== undefined) {
    if (refs.specRef === undefined && config.refs?.spec === undefined) signals.push('missing-spec-ref');
    if (refs.buildRef === undefined && config.refs?.build === undefined) signals.push('missing-build-ref');
  }
  if (record.carried) signals.push('carried-from-earlier-run');
  const variantArgs = variant === undefined ? [] : ['--variant', variant];
  const configArgs = config.configFile === undefined ? [] : ['--config', config.configFile];
  // The refs go beside the summary; name the directory when it isn't the command's default.
  const summaries = fromRoot(outputDir);
  const outputArgs = summaries === '.e2e/cige' ? [] : ['--output', summaries];
  const hasResolvers = config.refs !== undefined && Object.values(config.refs).some((resolver) => resolver !== undefined);
  const summary: CigeRunSummary = {
    testId: id,
    ...(variant === undefined ? {} : { variant }),
    runDate: record.runDate,
    ...(build === undefined ? {} : { build }),
    result: classification.result,
    intent: testCase?.intent.statement ?? record.title ?? id,
    ...(classification.failedStep === undefined ? {} : { failedStep: classification.failedStep }),
    ...(classification.failureType === undefined ? {} : { failureType: classification.failureType }),
    classification: {
      source: 'e2e-cige',
      confidence: 'heuristic',
      ...(classification.phase === undefined ? {} : { phase: classification.phase }),
      ...(classification.errorCode === undefined ? {} : { errorCode: classification.errorCode }),
      ...(classification.message === undefined ? {} : { message: classification.message }),
      signals,
      ...(adjustedBy.length === 0 ? {} : { adjustedBy }),
    },
    ...(refs.specRef === undefined ? {} : { specRef: refs.specRef }),
    ...(refs.buildRef === undefined ? {} : { buildRef: refs.buildRef }),
    ...(refs.expectedRef === undefined ? {} : { expectedRef: refs.expectedRef }),
    ...(hasResolvers ? { resolveRefs: ['npx', 'cige', 'refs', id, ...variantArgs, ...configArgs, ...outputArgs].map(shellArg).join(' ') } : {}),
    replay: replayOf(record, context),
    ...(testCase?.file === undefined ? {} : { case: fromRoot(testCase.file) }),
    target: record.target,
    agent: record.agent,
    attempts: record.attempts,
    runner: { name: record.runner.name, version: record.runner.version, ...(record.runner.selected === undefined ? {} : { selected: record.runner.selected }) },
    evidence: {
      ...(record.evidence.report === undefined ? {} : { report: record.evidence.report }),
      resultId: record.evidence.resultId,
      ...(record.evidence.trace === undefined ? {} : { trace: record.evidence.trace }),
      artifacts: record.evidence.artifacts,
      ...(record.evidence.recording === undefined ? {} : { recording: record.evidence.recording }),
      ...(record.evidence.groups === undefined ? {} : { groups: record.evidence.groups }),
    },
  };
  if (testCase === undefined) return summary;
  return withExtensions(summary, testCase, plugins);
}

/** The summary with the case's top-level `x-` keys, then each plugin's `summarize` fields under its name. */
export function withExtensions(summary: CigeRunSummary, testCase: CigeCase, plugins: readonly AnyPlugin[]): CigeRunSummary {
  const { extensions: _previous, ...rest } = summary;
  const base: CigeRunSummary = rest;
  const extensions: Record<string, unknown> = { ...testCase.extensions };
  for (const plugin of plugins) {
    if (plugin.summarize === undefined) continue;
    try {
      const fields = plugin.summarize({ testCase, summary: base });
      if (fields !== undefined) extensions[plugin.name] = fields;
    } catch (cause) {
      extensions[plugin.name] = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return Object.keys(extensions).length === 0 ? base : { ...base, extensions };
}

/** The runner a summary file belongs to: its `runner.name`; one written before runners had names, or that doesn't parse, is e2e's. */
export function summaryRunner(file: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'runner' in parsed) {
      const { runner } = parsed;
      if (typeof runner === 'object' && runner !== null && 'name' in runner && typeof runner.name === 'string') return runner.name;
    }
  } catch {
    // Unreadable: the oldest owner.
  }
  return 'e2e';
}

/**
 * Removes what an earlier run of this runner left in the summary directory
 * before this run writes its own, and nothing else: the directory may hold
 * other files, and other runners' summaries. After a full run every summary
 * of this runner and every resolved refs directory goes, so an old verdict
 * never passes for this run's. A partial run (a tag or file filter, `cige
 * replay`, `--last-failed`) removes only the summaries of the cases it ran,
 * under either naming, and keeps the rest, refs included: the cases it
 * skipped still stand as last reported.
 */
export function clearEarlier(outputDir: string, runner: string, partial: boolean, ran: readonly string[], known: readonly string[]): void {
  if (!existsSync(outputDir)) return;
  const ranNames = new Set(ran);
  // Longest name first, so a file of `a.b` is never taken for `a`.
  const stems = [...new Set([...ranNames, ...known])].map((name) => ({ name, stem: fileSafe(name) })).toSorted((a, b) => b.stem.length - a.stem.length);
  for (const file of readdirSync(outputDir)) {
    const target = path.join(outputDir, file);
    if (file.endsWith(REFS_SUFFIX)) {
      if (!partial) rmSync(target, { recursive: true, force: true });
      continue;
    }
    if (!file.endsWith(SUMMARY_SUFFIX)) continue;
    if (summaryRunner(target) !== runner) continue;
    const stem = file.slice(0, -SUMMARY_SUFFIX.length);
    const owner = stems.find((entry) => stem === entry.stem || stem.startsWith(`${entry.stem}.`));
    if (!partial || (owner !== undefined && ranNames.has(owner.name))) rmSync(target, { force: true });
  }
}

export interface WriteSummariesOptions<Fixtures = unknown> extends SummaryContext<Fixtures> {
  readonly runner: string;
  readonly records: readonly CigeRunRecord[];
  /** The base summary names (`<id>` or `<id>.<variant>`) the run ran; default the records' names. Files named after them, suffixes included, are replaced. */
  readonly ran?: readonly string[];
  /** Every summary name the run knows of, run or not: a partial run keeps the others. */
  readonly known: readonly string[];
  /** The run left cases out, so only the summaries of those it ran are replaced. */
  readonly partial: boolean;
  /** The cases that ran, unresolved, for the `CIGE gaps` row. */
  readonly ranCases: readonly CigeCase[];
}

export interface CigeSummaryCounts {
  pass: number;
  fail: number;
  skipped: number;
  interrupted: number;
}

/** Clears this runner's earlier summaries, writes one per record, and returns the terminal rows, or none when nothing ran. */
export function writeSummaries<Fixtures>(options: WriteSummariesOptions<Fixtures>): { readonly counts: CigeSummaryCounts; readonly rows?: { label: string; text: string }[]; readonly summaries: CigeRunSummary[] } {
  const { outputDir, records } = options;
  clearEarlier(outputDir, options.runner, options.partial, options.ran ?? records.map((record) => record.name), options.known);
  const counts: CigeSummaryCounts = { pass: 0, fail: 0, skipped: 0, interrupted: 0 };
  if (records.length === 0) return { counts, summaries: [] };
  mkdirSync(outputDir, { recursive: true });
  const written: CigeRunSummary[] = [];
  for (const record of records) {
    const summary = summarize(record, options);
    counts[summary.result] += 1;
    writeFileSync(path.join(outputDir, `${fileSafe(record.name)}${SUMMARY_SUFFIX}`), `${JSON.stringify(summary, null, 2)}\n`);
    written.push(summary);
  }
  const shown = path.relative(options.projectRoot, outputDir) || '.';
  const interrupted = counts.interrupted === 0 ? '' : `, ${counts.interrupted} interrupted`;
  const rows = [{ label: 'CIGE', text: `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped${interrupted}: ${shown}` }];
  // Said on every run, not only at the first failure: a case without refs can't be triaged when it matters.
  const unready = options.ranCases.filter((testCase) => readinessGaps(testCase, options.config).length > 0).length;
  if (unready > 0) {
    rows.push({ label: 'CIGE gaps', text: `${unready} case${unready === 1 ? '' : 's'} can't be fully classified or replayed: npx cige check` });
  }
  return { counts, rows, summaries: written };
}
