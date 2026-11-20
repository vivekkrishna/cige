/**
 * The runners the `cige` command can hand a case to: the config's
 * `runners`, else this package's own adapter by name, loaded only once it is
 * picked, so the command starts without either runner installed.
 */

import type { CigeConfig } from '../core/config.ts';
import type { CigeRunner, CigeRunnerSelection } from '../core/contract.ts';
import { AUTO, DEFAULT_PREFER, lastRunner, readHistory, routeCase, selectionOf, type RouteCandidate, type RouteDecision, type RunHistory } from '../core/route.ts';
import { BUILTIN_RUNNERS, defaultRunnerName, isInstalled, PLAYWRIGHT_PACKAGE } from '../core/select.ts';
import type { CigeCase } from '../core/schema.ts';

export class RunnerError extends Error {}

/** The runner named `name`: the config's, or the built-in adapter. */
export async function runnerFor(config: CigeConfig, name: string): Promise<CigeRunner> {
  if (name === AUTO) throw new RunnerError('auto is not a runner: it picks one per case');
  const configured = config.runners === undefined || !Object.hasOwn(config.runners, name) ? undefined : config.runners[name];
  if (configured !== undefined) {
    if (configured.name !== name) throw new RunnerError(`runners.${name} is the "${configured.name}" runner; list it under its own name`);
    return configured;
  }
  if (name === 'e2e') return (await import('../adapters/e2e/runner.ts')).e2eRunner();
  if (name === 'vibium') return (await import('../adapters/vibium/runner.ts')).vibiumRunner();
  if (name === 'playwright') return (await import('../adapters/playwright/runner.ts')).playwrightRunner();
  const known = [...new Set([...BUILTIN_RUNNERS, ...Object.keys(config.runners ?? {})])];
  throw new RunnerError(`no runner "${name}"; known: ${known.join(', ')}`);
}

/** The runner a case runs on when `--runner` names none, as configured: a name, or `auto`. */
export function caseRunnerName(config: CigeConfig, testCase: CigeCase, environment?: string): string {
  const name = environment ?? testCase.context.environment;
  const declared = name !== undefined && config.environments !== undefined && Object.hasOwn(config.environments, name) ? config.environments[name] : undefined;
  return defaultRunnerName(config, declared?.runner);
}

/** A case's runner for this command: a concrete name, and how `auto` picked it when it did. */
export interface ResolvedRunner {
  /** The runner's name; `auto` only when no runner can run the case (see `decision`). */
  readonly name: string;
  readonly selected?: CigeRunnerSelection;
  readonly decision?: RouteDecision;
}

/**
 * Resolves each case's runner for one command. A configured name passes
 * through; `auto` routes the case (`core/route.ts`), with the candidates'
 * availability and the summary history read once per command.
 */
export class Router {
  readonly #config: CigeConfig;
  readonly #outputDir: string;
  readonly #root: string;
  #candidates: Promise<RouteCandidate[]> | undefined;
  #history: RunHistory | undefined;

  /** `root`: absolute, the directory the config's globs resolve against, for a runner's `readiness`. */
  constructor(config: CigeConfig, outputDir: string, root: string) {
    this.#config = config;
    this.#outputDir = outputDir;
    this.#root = root;
  }

  /** The runners `auto` chooses among: `auto.prefer` first, then the config's own, then the built-ins. */
  candidates(): Promise<RouteCandidate[]> {
    this.#candidates ??= (async () => {
      const config = this.#config;
      const names = [...new Set([...(config.auto?.prefer ?? DEFAULT_PREFER), ...Object.keys(config.runners ?? {}), ...BUILTIN_RUNNERS])];
      const candidates: RouteCandidate[] = [];
      for (const name of names) {
        if (name === AUTO) continue;
        const listed = config.runners !== undefined && Object.hasOwn(config.runners, name);
        if (!listed && !(BUILTIN_RUNNERS as readonly string[]).includes(name)) continue;
        const runner = await runnerFor(config, name);
        const root = this.#root;
        candidates.push({
          name,
          capabilities: runner.capabilities,
          availability: runner.availability?.() ?? { ok: true },
          ...(runner.readiness === undefined ? {} : { blocking: (testCase: CigeCase) => runner.readiness!(testCase, { root }).blocking ?? [] }),
        });
      }
      return candidates;
    })();
    return this.#candidates;
  }

  /**
   * The case's runner. `force` routes it even when the config names one
   * (`--runner auto`); `reuseLast` takes an auto case's last runner, so a
   * replay or rejudge repeats the run it follows.
   */
  async resolve(testCase: CigeCase, options: { readonly environment?: string; readonly force?: boolean; readonly reuseLast?: boolean } = {}): Promise<ResolvedRunner> {
    const configured = caseRunnerName(this.#config, testCase, options.environment);
    if (options.force !== true && configured !== AUTO) return { name: configured };
    if (options.reuseLast === true) {
      const last = lastRunner(this.#outputDir, testCase);
      if (last !== undefined) return { name: last, selected: { by: 'auto', reason: `${last}: the runner of its last run, so this repeats that run` } };
    }
    this.#history ??= readHistory(this.#outputDir);
    const decision = routeCase(testCase, await this.candidates(), this.#history, this.#config);
    const selected = selectionOf(decision);
    return decision.runner === undefined ? { name: AUTO, decision } : { name: decision.runner, ...(selected === undefined ? {} : { selected }), decision };
  }
}

/** Stops with a clear message when a hosted runner's tool isn't installed. */
export function requireHosted(runner: CigeRunner): void {
  // Not a usage mistake, so no usage text: exit 1 with the fix.
  if (runner.name === 'e2e' && !isInstalled('e2e')) throw new Error('the e2e runner needs e2e installed beside e2e-cige: npm i -D e2e');
  if (runner.name === 'playwright' && !isInstalled(PLAYWRIGHT_PACKAGE)) throw new Error(`the playwright runner needs ${PLAYWRIGHT_PACKAGE} installed beside e2e-cige: npm i -D ${PLAYWRIGHT_PACKAGE}`);
}

/** The e2e config a case runs under: its environment's, then the e2e runner's, then the CIGE config's. */
export function e2eConfigFor(config: CigeConfig, runner: CigeRunner, environment: string | undefined): string | undefined {
  const declared = environment !== undefined && config.environments !== undefined && Object.hasOwn(config.environments, environment) ? config.environments[environment] : undefined;
  const own = 'config' in runner && typeof runner.config === 'string' ? runner.config : undefined;
  return declared?.config ?? own ?? config.e2eConfig;
}
