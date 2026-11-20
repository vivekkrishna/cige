/**
 * What `cige run` tells a hosted runner's reporter through the environment,
 * since the reporter runs in the runner's own process: whether its summary
 * names end in the runner's name (a matrix run, or cases off their default
 * runner), and why `auto` routed each case to it. The e2e reporter and the
 * Playwright reporter read the same variables.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CigeRunnerSelection } from './contract.ts';

/**
 * Set by `cige run` when a hosted runner shares the summaries with another
 * runner: each summary name gets `.<runner>` last, so the runners' summaries
 * sit side by side.
 */
export const RUNNER_SUFFIX_ENV = 'CIGE_RUNNER_SUFFIX';

/**
 * Set by `cige run` when `auto` routed cases to a hosted runner: the path of a
 * JSON file, `{ "cases": { "<id>[.<variant>]": { "runner": "<name>", "reason": "..." } } }`,
 * whose reasons the summaries record.
 */
export const RUNNER_SELECTION_ENV = 'CIGE_RUNNER_SELECTION';

/** The selection file for a runner: e2e's keeps the name it always had. */
function selectionFile(outputDir: string, runner: string): string {
  return path.join(outputDir, runner === 'e2e' ? 'runner-selection.json' : `runner-selection.${runner}.json`);
}

/** The env a hosted run needs for these flags, or undefined when it needs none, so a plain run is called as it always was. */
export function hostedEnv(
  runner: string,
  outputDir: string,
  suffix: boolean,
  selections: ReadonlyMap<string, CigeRunnerSelection>,
): Readonly<Record<string, string>> | undefined {
  const env: Record<string, string> = {};
  if (suffix) env[RUNNER_SUFFIX_ENV] = '1';
  if (selections.size > 0) {
    mkdirSync(outputDir, { recursive: true });
    const file = selectionFile(outputDir, runner);
    const cases = Object.fromEntries([...selections].map(([name, selected]) => [name, { runner, reason: selected.reason }]));
    writeFileSync(file, `${JSON.stringify({ cases }, null, 2)}\n`);
    env[RUNNER_SELECTION_ENV] = file;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/** Whether `cige run` asked this run's summary names to end in the runner's name. */
export function suffixRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RUNNER_SUFFIX_ENV] === '1';
}

/** The `auto` selections for `runner` that `cige run` handed this run, by base name. */
export function selectionsFor(runner: string, env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, CigeRunnerSelection> {
  const file = env[RUNNER_SELECTION_ENV];
  if (file === undefined || file === '') return new Map();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cases?: Record<string, { runner?: string; reason?: string }> };
    return new Map(
      Object.entries(parsed.cases ?? {}).flatMap(([name, entry]) =>
        entry.runner === runner && typeof entry.reason === 'string' ? [[name, { by: 'auto' as const, reason: entry.reason }]] : [],
      ),
    );
  } catch {
    // A selection file that doesn't read changes no verdict; the summaries just don't carry the reason.
    return new Map();
  }
}
