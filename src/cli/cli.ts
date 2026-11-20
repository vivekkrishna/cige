/**
 * The `cige` command: what an agent (or a person) runs between CIGE
 * runs. `run` runs the cases on a runner (e2e hands off to `e2e run`,
 * Playwright to `playwright test`; Vibium runs in the owned loop), `rejudge`
 * judges a stored recording again,
 * `replay` reruns one case in its environment after a repair, `env`
 * provisions, resets, or tears an environment down without touching any
 * case, `refs` fetches the spec, release notes, and expected output a
 * classifier compares a failure with, `check` lists what each case lacks
 * for that before anything fails, `compile` writes a case's Playwright spec
 * stubs, `healer` adds the CIGE rule to Playwright's healer agent, and
 * `diff` checks a change against the field rules. It reads `cige.config.ts`
 * from the working directory.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { capabilityGaps, readinessGaps, type CigeGap } from '../core/check.ts';
import { DEFAULT_CASES, type CigeConfig } from '../core/config.ts';
import type { CigeLaunchRequest, CigeRunner } from '../core/contract.ts';
import { diffSince, formatDiff } from '../core/diff.ts';
import { hostedEnv } from '../core/hosted.ts';
import { loadCigeCases, rootDir } from '../core/load.ts';
import { runCases } from '../core/owned.ts';
import { fileSafe, writeRefs } from '../core/refs.ts';
import type { CigeCase } from '../core/schema.ts';
import { parseRunnerList } from '../core/select.ts';
import { SUMMARY_SUFFIX, summarize, summaryRunner, type CigeRunSummary } from '../core/summary.ts';
import { cigeTag } from '../core/tags.ts';
import { caseForVariant, expandVariants } from '../core/variants.ts';
import type { CigeRunnerSelection } from '../core/contract.ts';
import { AUTO, baseName } from '../core/route.ts';
import { e2eConfigFor, requireHosted, Router, RunnerError, runnerFor, type ResolvedRunner } from './runners.ts';

/** A case no runner can serve, as the command reports it. */
function unroutable(testCase: CigeCase, resolved: ResolvedRunner): string {
  return `${baseName(testCase)}: ${resolved.decision?.reason ?? 'no runner can run it'}`;
}

const USAGE = `Usage: npx cige <command> [options]

Commands:
  run [<id>...] [--runner <name>[,<name>]|auto] [--tag <tag>]... [--variant <v>]
      [--workers <n>] [--retries <n>] [--last-failed] [--dry-run] [-- <e2e run options>]
      Run the cases on their runner (--runner, else the environment's, else
      the config's). e2e hands off to e2e run --tag, playwright to playwright
      test --grep @cige:<id>; an owned runner such as vibium runs here and
      writes the summaries. Two runners make a matrix
      run: each summary name ends in its runner's. auto picks one runner per
      case: one that enforces its guardrails, wasn't down last time, and can
      replay a passing run, in that order. --dry-run prints each case's
      runner and why, and runs nothing.
  replay <id> [--variant <v>] [--env <name>] [--runner <name>] [-- <e2e run options>]
      Reset the case's environment, then run the case alone: on e2e,
      e2e run [--config <env config>] --tag cige:<id> --no-cache; on
      playwright, playwright test --grep @cige:<id> --retries 0.
  rejudge <id> [--variant <v>] [--runner <name>]
      Judge the case's Intent again, as it reads now, on the recording its
      last run stored (vibium), and rewrite its summary.
  env <provision|reset|teardown> <name>
      Run one action of an environment the config declares.
  refs <id> [--variant <v>] [--build <build>] [--output <dir>]
      Resolve the case's spec, build, and expected refs into
      <output>/<id>.refs/ (default .e2e/cige).
  check [--resolve] [--warn] [--json] [--runner <name>[,<name>]]
      List what each case lacks for classification and replay: a spec or
      build ref, the build for {build}, a declared environment with a reset,
      and what its runner can't do (a platform, a session, an enforced
      guardrail). --resolve also runs the ref resolvers. Exits 1 on any gap
      unless --warn.
  compile [<id>...] [--force]
      Write each case's Playwright spec, <name>.cige.spec.ts beside its
      .cige.json: one binding stub per step, with its goal and the
      guardrails, for an agent or a person to fill in. No model call. Without
      ids, every case no spec binds yet. A spec that exists is left alone:
      the stubs it lacks are printed, and the exit is 1 (--force rewrites it).
  healer [--file <path>] [--print]
      Add the CIGE rule to the healer agent npx playwright init-agents wrote
      (.claude/agents, .github/agents, .opencode/prompts): read the run
      summary first, repair only outdated-test-logic, never a product defect.
      Running it again replaces the rule. --print shows it.
  diff [--base <git ref>] [--json] [--allow-intent]
      Check every .cige.json changed since the base (default origin/main)
      against the field rules, and report any change to the CIGE config or
      the local modules it imports. Exits 1 when a change weakens a case or
      touches the config.
      --allow-intent exits 0 anyway and records nothing: pass it only once
      a human approved the change, never from an agent.

Options:
  --config <file>   The CIGE config (default: cige.config.ts, .mts, .js, or .mjs
                    in the working directory)
`;

const CONFIG_FILES = ['cige.config.ts', 'cige.config.mts', 'cige.config.js', 'cige.config.mjs'];

/** What `main` writes to, where it runs, and how it starts `e2e`; tests replace them. */
export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runE2e: (args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<number>;
  /** Runs a hosted runner's command (a Node script, such as Playwright's); default a child process with this Node. */
  readonly runNode?: (script: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<number>;
}

/** The `e2e` bin a parsed `package.json` declares, when it is the runner's. */
function binOf(pkg: unknown): string | undefined {
  if (typeof pkg !== 'object' || pkg === null || !('name' in pkg) || pkg.name !== 'e2e' || !('bin' in pkg)) return undefined;
  const { bin } = pkg;
  if (typeof bin === 'string') return bin;
  if (typeof bin === 'object' && bin !== null && 'e2e' in bin && typeof bin.e2e === 'string') return bin.e2e;
  return undefined;
}

/** The `e2e` bin the installed runner declares, run with this Node. */
function e2eBin(): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve('e2e')));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      const bin = binOf(pkg);
      if (bin !== undefined) return path.resolve(dir, bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('cannot find the e2e command; install e2e beside e2e-cige');
    dir = parent;
  }
}

/** Runs a Node script with this Node, its output on ours, and resolves to its exit code. */
function spawnNode(script: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit', ...(env === undefined ? {} : { env: { ...process.env, ...env } }) });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}

const PROCESS_IO: CliIo = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  runE2e: (args, cwd, env) => spawnNode(e2eBin(), args, cwd, env),
  runNode: spawnNode,
};

/** Starts a hosted runner that declares its own command (`launch`), with the env the reporter reads. */
async function launchHosted(io: CliIo, loaded: Loaded, runner: CigeRunner, request: Omit<CigeLaunchRequest, 'cwd'>, outputDir: string, suffix: boolean, selections: ReadonlyMap<string, CigeRunnerSelection>): Promise<number> {
  const launch = runner.launch!({ ...request, cwd: loaded.dir });
  io.stderr(`cige: ${launch.display}\n`);
  const env = hostedEnv(runner.name, outputDir, suffix, selections);
  return (io.runNode ?? spawnNode)(launch.script, launch.args, loaded.dir, env);
}

/** Absolute: the directory the config's globs resolve against. */
function rootOf(loaded: Loaded): string {
  return rootDir(loaded.config.root ?? loaded.dir);
}

class UsageError extends Error {}

interface Loaded {
  readonly config: CigeConfig;
  /** Where the config's relative paths resolve from: its own directory. */
  readonly dir: string;
  readonly file?: string;
}

async function loadConfig(cwd: string, explicit: string | undefined, required: boolean): Promise<Loaded> {
  const file = explicit === undefined ? CONFIG_FILES.map((name) => path.join(cwd, name)).find((candidate) => existsSync(candidate)) : path.resolve(cwd, explicit);
  if (file === undefined || !existsSync(file)) {
    if (required || explicit !== undefined) throw new UsageError(`no CIGE config at ${explicit ?? CONFIG_FILES[0]}; export defineCige({...}) from it`);
    return { config: {}, dir: cwd };
  }
  const module = (await import(pathToFileURL(file).href)) as { default?: CigeConfig };
  if (module.default === undefined || typeof module.default !== 'object') throw new UsageError(`${file} has no default export; export default defineCige({...})`);
  return { config: module.default, dir: path.dirname(file), file };
}

function findCase(loaded: Loaded, id: string, variant: string | undefined): CigeCase {
  const cases = loadCigeCases(loaded.config.cases ?? DEFAULT_CASES, { root: loaded.config.root ?? loaded.dir });
  const testCase = cases.find((candidate) => candidate.id === id);
  if (testCase === undefined) throw new UsageError(`no CIGE case has the id "${id}"; known: ${cases.map((candidate) => candidate.id).join(', ') || 'none'}`);
  const resolved = caseForVariant(testCase, variant);
  if (resolved === undefined) {
    throw new UsageError(
      variant === undefined
        ? `case "${id}" has variants; pass --variant ${testCase.variants.map((entry) => entry.id).join('|')}`
        : `case "${id}" has no variant "${variant}"`,
    );
  }
  return resolved;
}

function environmentOf(config: CigeConfig, name: string): NonNullable<CigeConfig['environments']>[string] {
  const environments = config.environments ?? {};
  if (!Object.hasOwn(environments, name)) {
    throw new UsageError(`the config declares no environment "${name}"; known: ${Object.keys(environments).join(', ') || 'none'}`);
  }
  return environments[name]!;
}

async function replay(io: CliIo, args: readonly string[]): Promise<number> {
  const split = args.indexOf('--');
  const own = split === -1 ? args : args.slice(0, split);
  const passthrough = split === -1 ? [] : args.slice(split + 1);
  const { values, positionals } = parseArgs({
    args: [...own],
    allowPositionals: true,
    options: { variant: { type: 'string' }, env: { type: 'string' }, config: { type: 'string' }, runner: { type: 'string' } },
  });
  const [id] = positionals;
  if (id === undefined || positionals.length > 1) throw new UsageError('replay takes one case id');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const testCase = findCase(loaded, id, values.variant);
  const name = values.env ?? testCase.context.environment;
  // A case's environment is prose until the config declares environments; only a declared one is acted on.
  const environment =
    name === undefined || (values.env === undefined && loaded.config.environments === undefined) ? undefined : environmentOf(loaded.config, name);
  if (environment !== undefined) {
    // A replay on state the last run left behind proves nothing about the repair.
    if (environment.reset === undefined) {
      throw new UsageError(`environment "${name}" has no reset action; declare one (a no-op when the environment keeps no state)`);
    }
    io.stderr(`cige: resetting ${name}\n`);
    await environment.reset();
  }
  if (values.runner !== undefined && parseRunnerList(values.runner).length !== 1) throw new UsageError('replay runs on one runner');
  // An auto case replays on the runner of its last run, so the replay repeats what failed; --runner auto routes it afresh.
  const router = new Router(loaded.config, owned(loaded, undefined).outputDir, rootOf(loaded));
  const home = await router.resolve(testCase, { ...(values.env === undefined ? {} : { environment: values.env }), force: values.runner === AUTO, reuseLast: values.runner !== AUTO });
  if (home.name === AUTO && (values.runner === undefined || values.runner === AUTO)) throw new UsageError(`auto can't route ${unroutable(testCase, home)}`);
  const runner = await runnerFor(loaded.config, values.runner === undefined || values.runner === AUTO ? home.name : values.runner);
  const selections = new Map(home.selected !== undefined && runner.name === home.name ? [[baseName(testCase), home.selected]] : []);
  if (runner.capabilities.mode === 'owned') {
    if (passthrough.length > 0) io.stderr(`cige: ${runner.name} takes no e2e run options; ignoring ${passthrough.join(' ')}\n`);
    io.stderr(`cige: ${runner.name} replay ${testCase.id}${testCase.variant === undefined ? '' : `/${testCase.variant}`}\n`);
    const result = await runCases({
      ...owned(loaded, undefined),
      runner,
      suffix: runner.name !== home.name,
      selections,
      ids: [testCase.variant === undefined ? testCase.id : `${testCase.id}/${testCase.variant}`],
      ...(values.env === undefined ? {} : { environment: values.env }),
      log: io.stderr,
    });
    for (const row of result.rows) io.stdout(`${row.label}: ${row.text}\n`);
    return result.exitCode;
  }
  requireHosted(runner);
  if (runner.launch !== undefined) {
    return launchHosted(
      io,
      loaded,
      runner,
      { tags: [cigeTag(testCase.id, testCase.variant)], replay: true, ...(name === undefined ? {} : { environment: name }), passthrough },
      owned(loaded, undefined).outputDir,
      runner.name !== home.name,
      selections,
    );
  }
  const e2eConfig = e2eConfigFor(loaded.config, runner, name);
  const e2eArgs = [
    'run',
    ...(e2eConfig === undefined ? [] : ['--config', e2eConfig]),
    '--tag',
    cigeTag(testCase.id, testCase.variant),
    '--no-cache',
    ...passthrough,
  ];
  io.stderr(`cige: e2e ${e2eArgs.join(' ')}\n`);
  // Off the case's default runner, its summaries take the runner's name, as `cige run` writes them.
  const env = hostedEnv('e2e', owned(loaded, undefined).outputDir, runner.name !== home.name, selections);
  return env === undefined ? io.runE2e(e2eArgs, loaded.dir) : io.runE2e(e2eArgs, loaded.dir, env);
}

/** Where an owned run writes, and what its paths are relative to: the config's directory. */
function owned(loaded: Loaded, output: string | undefined) {
  return {
    config: loaded.config,
    configDir: loaded.dir,
    projectRoot: loaded.dir,
    outputDir: path.resolve(loaded.dir, output ?? loaded.config.outputDir ?? path.join('.e2e', 'cige')),
  };
}

function count(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`${flag} takes a whole number`);
  return parsed;
}

async function run(io: CliIo, args: readonly string[]): Promise<number> {
  const split = args.indexOf('--');
  const own = split === -1 ? args : args.slice(0, split);
  const passthrough = split === -1 ? [] : args.slice(split + 1);
  const { values, positionals } = parseArgs({
    args: [...own],
    allowPositionals: true,
    options: {
      runner: { type: 'string' },
      tag: { type: 'string', multiple: true },
      variant: { type: 'string' },
      workers: { type: 'string' },
      retries: { type: 'string' },
      'last-failed': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      output: { type: 'string' },
      config: { type: 'string' },
    },
  });
  const loaded = await loadConfig(io.cwd, values.config, false);
  const cases = loadCigeCases(loaded.config.cases ?? DEFAULT_CASES, { root: loaded.config.root ?? loaded.dir });
  for (const id of positionals) {
    const [caseId] = id.split('/');
    if (!cases.some((testCase) => testCase.id === caseId)) throw new UsageError(`no CIGE case has the id "${caseId}"; known: ${cases.map((testCase) => testCase.id).join(', ') || 'none'}`);
  }
  const workers = count(values.workers, '--workers');
  const retries = count(values.retries, '--retries');
  const listed = values.runner === undefined ? undefined : parseRunnerList(values.runner);
  if (listed !== undefined && listed.length === 0) throw new UsageError('--runner names no runner');
  if (listed !== undefined && listed.length > 1 && listed.includes(AUTO)) throw new UsageError("auto picks one runner per case; it can't join a matrix run");
  // --runner auto routes every case; without --runner, each case goes to its own runner: its environment's, else the config's (which may be auto).
  const forceAuto = listed?.[0] === AUTO;
  const explicit = forceAuto ? undefined : listed;
  const resolved = cases.flatMap((testCase) => expandVariants(testCase));
  const selected = resolved.filter(
    (testCase) =>
      (positionals.length === 0 || positionals.some((id) => id === testCase.id || id === `${testCase.id}/${testCase.variant}`)) &&
      (values.variant === undefined || testCase.variant === values.variant) &&
      (values.tag === undefined || values.tag.some((tag) => tag === 'cige' || tag === cigeTag(testCase.id) || tag === cigeTag(testCase.id, testCase.variant))),
  );
  // One group per runner, and per whether its summaries need the runner's name: a matrix run, or a case off its default runner.
  const matrix = explicit !== undefined && explicit.length > 1;
  const router = new Router(loaded.config, owned(loaded, values.output).outputDir, rootOf(loaded));
  const groups = new Map<string, { name: string; suffix: boolean; cases: CigeCase[]; selections: Map<string, CigeRunnerSelection> }>();
  const refused: string[] = [];
  const routes: string[] = [];
  for (const testCase of selected) {
    const own = await router.resolve(testCase, { force: forceAuto });
    if (own.name === AUTO) {
      refused.push(unroutable(testCase, own));
      continue;
    }
    for (const name of explicit ?? [own.name]) {
      const suffix = matrix || name !== own.name;
      routes.push(`${baseName(testCase)}\t${name}\t${name === own.name ? (own.selected?.reason ?? 'configured') : `--runner ${name}`}`);
      const key = `${name}${suffix ? '+suffix' : ''}`;
      const group = groups.get(key) ?? { name, suffix, cases: [], selections: new Map<string, CigeRunnerSelection>() };
      group.cases.push(testCase);
      if (own.selected !== undefined && name === own.name) group.selections.set(baseName(testCase), own.selected);
      groups.set(key, group);
    }
  }
  if (refused.length > 0) throw new UsageError(`auto can't route ${refused.length} case${refused.length === 1 ? '' : 's'}, so nothing ran:\n  ${refused.join('\n  ')}`);
  if (values['dry-run'] === true) {
    io.stdout(`case\trunner\twhy\n${routes.map((line) => `${line}\n`).join('')}`);
    return 0;
  }
  const filtered = positionals.length > 0 || values.tag !== undefined || values.variant !== undefined || groups.size > 1;
  let exitCode = 0;
  for (const { name, suffix, cases: group, selections } of groups.values()) {
    const runner = await runnerFor(loaded.config, name);
    io.stderr(`cige: ${group.length} case run${group.length === 1 ? '' : 's'} on ${name}\n`);
    const flags = { workers, retries, suffix, filtered, selections };
    const code = runner.capabilities.mode === 'owned' ? await runOwned(io, loaded, runner, group, values, flags) : await runHosted(io, loaded, runner, group, values, passthrough, flags);
    exitCode = Math.max(exitCode, code);
  }
  if (groups.size === 0) io.stderr('cige: no case matches\n');
  return exitCode;
}

interface RunFlags {
  readonly workers: number | undefined;
  readonly retries: number | undefined;
  /** End summary names in the runner's. */
  readonly suffix: boolean;
  /** The run names its cases one by one: a filter, or cases split between runners. */
  readonly filtered: boolean;
  /** How `auto` picked this runner, by base name. */
  readonly selections: ReadonlyMap<string, CigeRunnerSelection>;
}

async function runOwned(
  io: CliIo,
  loaded: Loaded,
  runner: CigeRunner,
  group: readonly CigeCase[],
  values: { readonly 'last-failed'?: boolean; readonly output?: string },
  flags: RunFlags,
): Promise<number> {
  const result = await runCases({
    ...owned(loaded, values.output),
    runner,
    ...(flags.filtered ? { ids: group.map((testCase) => (testCase.variant === undefined ? testCase.id : `${testCase.id}/${testCase.variant}`)) } : {}),
    ...(values['last-failed'] === true ? { lastFailed: true } : {}),
    ...(flags.workers === undefined ? {} : { workers: flags.workers }),
    ...(flags.retries === undefined ? {} : { retries: flags.retries }),
    suffix: flags.suffix,
    selections: flags.selections,
    log: io.stderr,
  });
  for (const row of result.rows) io.stdout(`${row.label}: ${row.text}\n`);
  return result.exitCode;
}

async function runHosted(
  io: CliIo,
  loaded: Loaded,
  runner: CigeRunner,
  group: readonly CigeCase[],
  values: { readonly 'last-failed'?: boolean; readonly output?: string },
  passthrough: readonly string[],
  flags: RunFlags,
): Promise<number> {
  requireHosted(runner);
  const environments = [...new Set(group.map((testCase) => testCase.context.environment))];
  if (runner.launch !== undefined) {
    const shared = environments.length === 1 ? environments[0] : undefined;
    return launchHosted(
      io,
      loaded,
      runner,
      {
        tags: flags.filtered ? group.map((testCase) => cigeTag(testCase.id, testCase.variant)) : ['cige'],
        ...(values['last-failed'] === true ? { lastFailed: true } : {}),
        ...(flags.workers === undefined ? {} : { workers: flags.workers }),
        ...(flags.retries === undefined ? {} : { retries: flags.retries }),
        ...(shared === undefined ? {} : { environment: shared }),
        passthrough,
      },
      owned(loaded, values.output).outputDir,
      flags.suffix,
      flags.selections,
    );
  }
  const e2eConfig = e2eConfigFor(loaded.config, runner, environments.length === 1 ? environments[0] : undefined);
  const tags = flags.filtered ? group.map((testCase) => cigeTag(testCase.id, testCase.variant)) : ['cige'];
  const e2eArgs = [
    'run',
    ...(e2eConfig === undefined ? [] : ['--config', e2eConfig]),
    ...tags.flatMap((tag) => ['--tag', tag]),
    ...(values['last-failed'] === true ? ['--last-failed'] : []),
    ...(flags.workers === undefined ? [] : ['--workers', String(flags.workers)]),
    ...(flags.retries === undefined ? [] : ['--retries', String(flags.retries)]),
    ...passthrough,
  ];
  io.stderr(`cige: e2e ${e2eArgs.join(' ')}\n`);
  const env = hostedEnv('e2e', owned(loaded, values.output).outputDir, flags.suffix, flags.selections);
  return env === undefined ? io.runE2e(e2eArgs, loaded.dir) : io.runE2e(e2eArgs, loaded.dir, env);
}

async function rejudge(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { variant: { type: 'string' }, runner: { type: 'string' }, output: { type: 'string' }, config: { type: 'string' } },
  });
  const [id] = positionals;
  if (id === undefined || positionals.length > 1) throw new UsageError('rejudge takes one case id');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const testCase = findCase(loaded, id, values.variant);
  if (!testCase.intent.judge) throw new UsageError(`case "${id}" turns its judgment off ("judge": false): there is no Intent judgment to repeat`);
  const resolved = values.runner === undefined ? await new Router(loaded.config, owned(loaded, values.output).outputDir, rootOf(loaded)).resolve(testCase, { reuseLast: true }) : { name: values.runner };
  if (resolved.name === AUTO) throw new UsageError(`auto can't route ${unroutable(testCase, resolved)}`);
  const runner = await runnerFor(loaded.config, resolved.name);
  if (runner.rejudge === undefined || !runner.capabilities.archiveJudge) throw new UsageError(`the ${runner.name} runner can't judge a stored recording; replay the case instead`);
  const { outputDir, projectRoot } = owned(loaded, values.output);
  const base = testCase.variant === undefined ? testCase.id : `${testCase.id}.${testCase.variant}`;
  // Its own runner's summary: suffixed when it ran off its default runner, else plain.
  const candidates = [`${base}.${runner.name}`, base].map((name) => path.join(outputDir, `${fileSafe(name)}${SUMMARY_SUFFIX}`)).filter((candidate) => existsSync(candidate));
  const file = candidates.find((candidate) => summaryRunner(candidate) === runner.name);
  if (file === undefined) throw new UsageError(`no ${runner.name} run summary of "${base}" in ${path.relative(io.cwd, outputDir) || '.'}; run it on ${runner.name} first`);
  const previous = JSON.parse(readFileSync(file, 'utf8')) as CigeRunSummary;
  if (previous.result === 'fail' && previous.failedStep !== 'intent') {
    throw new UsageError(`the last run of "${base}" failed at ${previous.failedStep ?? previous.classification.phase ?? 'setup'}, before its Intent was judged; replay it instead`);
  }
  const recording = previous.evidence.recording;
  if (recording === undefined || !existsSync(path.resolve(projectRoot, recording))) throw new UsageError(`the last run of "${base}" stored no recording to judge`);
  const outcome = await runner.rejudge({ testCase, recording: path.resolve(projectRoot, recording) });
  const summary = summarize(
    {
      key: { id: testCase.id, ...(testCase.variant === undefined ? {} : { variant: testCase.variant }) },
      name: path.basename(file, SUMMARY_SUFFIX),
      runner: { name: runner.name, version: runner.version },
      testCase,
      outcome,
      runDate: new Date().toISOString().slice(0, 10),
      target: previous.target,
      agent: previous.agent,
      attempts: previous.attempts,
      carried: false,
      narrow: [],
      evidence: previous.evidence,
    },
    { config: loaded.config, outputDir, projectRoot },
  );
  const rejudged: CigeRunSummary = {
    ...summary,
    rejudged: { from: previous.runDate, previous: previous.result, ...(previous.failureType === undefined ? {} : { previousFailureType: previous.failureType }) },
  };
  writeFileSync(file, `${JSON.stringify(rejudged, null, 2)}\n`);
  io.stdout(`${base}: ${previous.result} -> ${rejudged.result}${rejudged.failureType === undefined ? '' : ` (${rejudged.failureType})`}: ${path.relative(io.cwd, file)}\n`);
  return rejudged.result === 'fail' ? 1 : 0;
}

const ACTIONS = ['provision', 'reset', 'teardown'] as const;

async function env(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { config: { type: 'string' } } });
  const [action, name] = positionals;
  if (action === undefined || name === undefined || positionals.length > 2 || !(ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`env takes an action (${ACTIONS.join('|')}) and an environment name`);
  }
  const loaded = await loadConfig(io.cwd, values.config, true);
  const run = environmentOf(loaded.config, name)[action as (typeof ACTIONS)[number]];
  if (run === undefined) throw new UsageError(`environment "${name}" has no ${action} action`);
  await run();
  io.stdout(`${action} ${name}: done\n`);
  return 0;
}

async function refs(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { variant: { type: 'string' }, build: { type: 'string' }, output: { type: 'string' }, config: { type: 'string' } },
  });
  const [id] = positionals;
  if (id === undefined || positionals.length > 1) throw new UsageError('refs takes one case id');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const testCase = findCase(loaded, id, values.variant);
  const outputDir = path.resolve(loaded.dir, values.output ?? loaded.config.outputDir ?? path.join('.e2e', 'cige'));
  const build = values.build ?? loaded.config.build;
  const { directory, index } = await writeRefs(testCase, {
    outputDir,
    ...(loaded.config.refs === undefined ? {} : { refs: loaded.config.refs }),
    ...(build === undefined ? {} : { build }),
  });
  io.stdout(`${path.relative(io.cwd, directory) || '.'}\n`);
  const failed = Object.entries(index.refs).filter(([, entry]) => entry.error !== undefined);
  for (const [kind, entry] of failed) io.stderr(`cige: the ${kind} resolver failed: ${entry.error}\n`);
  return failed.length > 0 ? 1 : 0;
}

async function check(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      resolve: { type: 'boolean' },
      warn: { type: 'boolean' },
      json: { type: 'boolean' },
      build: { type: 'string' },
      output: { type: 'string' },
      config: { type: 'string' },
      runner: { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new UsageError('check takes no positional arguments');
  const listed = values.runner === undefined ? undefined : parseRunnerList(values.runner);
  if (listed !== undefined && listed.length > 1 && listed.includes(AUTO)) throw new UsageError("auto picks one runner per case; check it alone or name the runners");
  const forceAuto = listed?.[0] === AUTO;
  const explicit = forceAuto ? undefined : listed;
  const loaded = await loadConfig(io.cwd, values.config, false);
  const build = values.build ?? loaded.config.build;
  const config = { ...loaded.config, build };
  const cases = loadCigeCases(config.cases ?? DEFAULT_CASES, { root: config.root ?? loaded.dir });
  const outputDir = path.resolve(loaded.dir, values.output ?? config.outputDir ?? path.join('.e2e', 'cige'));
  const results: { readonly id: string; readonly file?: string; readonly gaps: readonly CigeGap[]; readonly routed?: { readonly runner: string; readonly reason: string } }[] = [];
  const router = new Router(config, outputDir, rootOf(loaded));
  for (const testCase of cases) {
    const gaps = readinessGaps(testCase, config);
    let routed: { runner: string; reason: string } | undefined;
    if (explicit === undefined) {
      const own = await router.resolve(testCase, { force: forceAuto });
      if (own.name === AUTO) gaps.push({ kind: 'runner', runner: AUTO, detail: own.decision?.reason ?? 'no runner can run it' });
      else {
        if (own.selected !== undefined) routed = { runner: own.name, reason: own.selected.reason };
        gaps.push(...capabilityGaps(testCase, await runnerFor(config, own.name), config, { root: rootOf(loaded) }));
      }
    }
    for (const name of explicit ?? []) {
      const runner = await runnerFor(config, name);
      gaps.push(...capabilityGaps(testCase, runner, config, { root: rootOf(loaded) }));
    }
    if (values.resolve === true && config.refs !== undefined) {
      const { index } = await writeRefs(testCase, { outputDir, refs: config.refs, ...(build === undefined ? {} : { build }) });
      for (const [kind, entry] of Object.entries(index.refs)) {
        if (entry.error !== undefined) gaps.push({ kind: 'resolver-failed', detail: `the ${kind} resolver failed: ${entry.error}` });
      }
    }
    const file = testCase.file === undefined ? undefined : path.relative(io.cwd, testCase.file);
    results.push({ id: testCase.id, ...(file === undefined ? {} : { file }), gaps, ...(routed === undefined ? {} : { routed }) });
  }
  const withGaps = results.filter((result) => result.gaps.length > 0);
  const routedCases = results.filter((result) => result.routed !== undefined);
  if (values.json === true) {
    io.stdout(
      `${JSON.stringify({ cases: results.length, ready: results.length - withGaps.length, results: withGaps, ...(routedCases.length === 0 ? {} : { routes: routedCases.map(({ id, routed }) => ({ id, ...routed })) }) }, null, 2)}\n`,
    );
  } else {
    for (const result of routedCases) io.stdout(`${result.id}: auto runs it on ${result.routed!.reason}\n`);
    for (const result of withGaps) {
      io.stdout(`${result.file ?? result.id} (${result.id})\n`);
      for (const gap of result.gaps) io.stdout(`  ${gap.kind}${gap.plugin === undefined ? '' : ` (${gap.plugin})`}${gap.runner === undefined ? '' : ` (${gap.runner})`}: ${gap.detail}\n`);
    }
    io.stdout(
      withGaps.length === 0
        ? `All ${results.length} CIGE case${results.length === 1 ? ' is' : 's are'} ready to classify and replay.\n`
        : `${withGaps.length} of ${results.length} CIGE case${results.length === 1 ? '' : 's'} ${withGaps.length === 1 ? 'has' : 'have'} gaps.\n`,
    );
  }
  return withGaps.length > 0 && values.warn !== true ? 1 : 0;
}

async function compile(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { force: { type: 'boolean' }, config: { type: 'string' } } });
  const loaded = await loadConfig(io.cwd, values.config, true);
  const configFile = loaded.file!;
  const root = rootOf(loaded);
  const cases = loadCigeCases(loaded.config.cases ?? DEFAULT_CASES, { root });
  for (const id of positionals) {
    if (!cases.some((testCase) => testCase.id === id)) throw new UsageError(`no CIGE case has the id "${id}"; known: ${cases.map((testCase) => testCase.id).join(', ') || 'none'}`);
  }
  const { configImport, boundIds, renderSpec, renderStubs, specPathFor } = await import('../adapters/playwright/scaffold.ts');
  const { DEFAULT_SPECS, specsBinding } = await import('../adapters/playwright/runner.ts');
  const configured = loaded.config.runners !== undefined && Object.hasOwn(loaded.config.runners, 'playwright') ? loaded.config.runners.playwright : undefined;
  const specs = configured !== undefined && 'specs' in configured && Array.isArray(configured.specs) ? (configured.specs as string[]) : DEFAULT_SPECS;
  const shown = (file: string): string => path.relative(io.cwd, file) || file;
  let exitCode = 0;
  let written = 0;
  for (const testCase of cases) {
    const existing = specsBinding(testCase.id, root, specs)[0];
    if (positionals.length > 0 ? !positionals.includes(testCase.id) : existing !== undefined) continue;
    const target = existing ?? specPathFor(testCase.file ?? path.join(root, `${testCase.id}.cige.json`));
    if (existing !== undefined && values.force !== true) {
      const bound = new Set(boundIds(readFileSync(existing, 'utf8')));
      const needed = testCase.execution.filter((step) => step.kind !== 'use').map((step) => step.id);
      const missing = needed.filter((id) => !bound.has(id));
      const extra = [...bound].filter((id) => !needed.includes(id));
      if (missing.length === 0 && extra.length === 0) {
        io.stdout(`${shown(existing)}: binds every step of ${testCase.id}\n`);
        continue;
      }
      exitCode = 1;
      if (extra.length > 0) io.stdout(`${shown(existing)}: binds ${extra.join(', ')}, which ${testCase.id} has no act or verify step for\n`);
      if (missing.length > 0) io.stdout(`${shown(existing)}: no binding for ${missing.join(', ')}; add to its bindings:\n${renderStubs(testCase, missing)}\n`);
      continue;
    }
    if (existing === undefined && existsSync(target) && values.force !== true) {
      // A file by that name that binds another case: never overwrite what isn't ours.
      io.stderr(`cige: ${shown(target)} exists and binds no case ${testCase.id}; pass --force to overwrite it\n`);
      exitCode = 1;
      continue;
    }
    writeFileSync(target, renderSpec(testCase, configImport(target, configFile)));
    written += 1;
    io.stdout(`wrote ${shown(target)}\n`);
  }
  if (written === 0 && exitCode === 0 && positionals.length === 0) io.stdout('every case has a spec\n');
  return exitCode;
}

async function healer(io: CliIo, args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { file: { type: 'string', multiple: true }, print: { type: 'boolean' }, output: { type: 'string' }, config: { type: 'string' } },
  });
  if (positionals.length > 0) throw new UsageError('healer takes no positional arguments');
  const loaded = await loadConfig(io.cwd, values.config, false);
  const summaries = path.relative(loaded.dir, owned(loaded, values.output).outputDir).split(path.sep).join('/') || '.';
  const { healerBlock, healerFiles, installHealerBlock } = await import('../adapters/playwright/healer.ts');
  const block = healerBlock(summaries);
  if (values.print === true) {
    io.stdout(`${block}\n`);
    return 0;
  }
  const files = values.file === undefined ? healerFiles(loaded.dir) : values.file.map((file) => path.resolve(io.cwd, file));
  if (files.length === 0) {
    io.stderr('cige: no healer agent found; generate one with npx playwright init-agents --loop=claude (or vscode, opencode), or pass --file\n');
    return 1;
  }
  for (const file of files) {
    if (!existsSync(file)) throw new UsageError(`no file at ${file}`);
    const changed = installHealerBlock(file, block);
    io.stdout(`${path.relative(io.cwd, file) || file}: ${changed ? 'added the CIGE rule' : 'already has the CIGE rule'}\n`);
  }
  return 0;
}

function diff(io: CliIo, args: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { base: { type: 'string' }, json: { type: 'boolean' }, 'allow-intent': { type: 'boolean' }, config: { type: 'string' } },
  });
  if (positionals.length > 0) throw new UsageError('diff takes no positional arguments');
  // Not loaded here: diff loads it in a child process, so a config that fails to load blocks rather than hides its change.
  // Every default name, existing or not: a config deleted on this branch still exists at the merge base.
  const configFiles = values.config === undefined ? CONFIG_FILES.map((name) => path.join(io.cwd, name)) : [path.resolve(io.cwd, values.config)];
  if (values.config !== undefined && !(existsSync(configFiles[0]!) && statSync(configFiles[0]!).isFile())) throw new UsageError(`no CIGE config at ${values.config}; export defineCige({...}) from it`);
  const report = diffSince(values.base ?? 'origin/main', io.cwd, { configFiles });
  io.stdout(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatDiff(report));
  return report.blocking > 0 && values['allow-intent'] !== true ? 1 : 0;
}

/** Runs `cige` with the arguments after the command name and resolves to the exit code. */
export async function main(args: readonly string[], io: CliIo = PROCESS_IO): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  try {
    if (command === 'run') return await run(io, rest);
    if (command === 'replay') return await replay(io, rest);
    if (command === 'rejudge') return await rejudge(io, rest);
    if (command === 'env') return await env(io, rest);
    if (command === 'refs') return await refs(io, rest);
    if (command === 'check') return await check(io, rest);
    if (command === 'compile') return await compile(io, rest);
    if (command === 'healer') return await healer(io, rest);
    if (command === 'diff') return diff(io, rest);
    throw new UsageError(`unknown command "${command}"`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof RunnerError || (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'))) {
      io.stderr(`cige: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`cige: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
