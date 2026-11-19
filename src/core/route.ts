/**
 * `auto` routing: the runner a case runs on, picked per case just before it
 * runs. It never switches runners inside a case (two sessions share no page
 * state) and never reruns a failure elsewhere (an agentic pass would hide
 * the stale path or defect the case exists to catch): it picks one runner,
 * says why, and that runner's verdict is the case's.
 *
 * Deterministic and explained. A runner that can't serve the case is
 * excluded: not available now, a platform it doesn't run, a step kind no
 * plugin registers for it, a saved session it can't restore. The rest rank,
 * in order, by:
 *
 * 1. the fewest guardrails it can only advise, not enforce (safety first);
 * 2. not having failed as infrastructure on its last run of the case;
 * 3. a deterministic replay of its last passing run (no model calls);
 * 4. `auto.prefer` order (default e2e, then Vibium).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CigeConfig } from './config.ts';
import type { CigeAvailability, CigeCapabilities, CigeRunnerSelection } from './contract.ts';
import { missingStepKinds } from './plugins.ts';
import type { CigeCase } from './schema.ts';
import { SUMMARY_SUFFIX, summaryRunner, type CigeRunSummary } from './summary.ts';

/** The runner name that asks for routing. */
export const AUTO = 'auto';

/** The order `auto` prefers runners in when nothing else separates them. */
export const DEFAULT_PREFER: readonly string[] = ['e2e', 'vibium'];

export interface RouteCandidate {
  readonly name: string;
  readonly capabilities: CigeCapabilities;
  readonly availability: CigeAvailability;
}

/** The latest summary of each case on each runner: base name (`<id>` or `<id>.<variant>`), then runner name. */
export type RunHistory = ReadonlyMap<string, ReadonlyMap<string, CigeRunSummary>>;

export interface RouteConsidered {
  readonly name: string;
  readonly eligible: boolean;
  /** Why it can't run the case, or what counted for and against it. */
  readonly why: readonly string[];
}

export interface RouteDecision {
  /** The runner picked; undefined when none can run the case. */
  readonly runner?: string;
  /** One line: why this runner, or why none. */
  readonly reason: string;
  readonly considered: readonly RouteConsidered[];
}

/** The name a resolved case's summaries are written under, before any runner suffix. */
export function baseName(testCase: CigeCase): string {
  return testCase.variant === undefined ? testCase.id : `${testCase.id}.${testCase.variant}`;
}

/** Every summary in the directory, latest per case per runner (by run date, then file time). */
export function readHistory(outputDir: string): RunHistory {
  const history = new Map<string, Map<string, { summary: CigeRunSummary; at: string }>>();
  if (!existsSync(outputDir)) return new Map();
  for (const file of readdirSync(outputDir)) {
    if (!file.endsWith(SUMMARY_SUFFIX)) continue;
    const target = path.join(outputDir, file);
    let summary: CigeRunSummary;
    try {
      summary = JSON.parse(readFileSync(target, 'utf8')) as CigeRunSummary;
    } catch {
      continue;
    }
    if (typeof summary.testId !== 'string' || typeof summary.result !== 'string') continue;
    const base = summary.variant === undefined ? summary.testId : `${summary.testId}.${summary.variant}`;
    const runner = summaryRunner(target);
    const at = `${summary.runDate ?? ''}|${statSync(target).mtime.toISOString()}`;
    const byRunner = history.get(base) ?? new Map<string, { summary: CigeRunSummary; at: string }>();
    const current = byRunner.get(runner);
    if (current === undefined || current.at < at) byRunner.set(runner, { summary, at });
    history.set(base, byRunner);
  }
  return new Map([...history].map(([base, byRunner]) => [base, new Map([...byRunner].map(([runner, entry]) => [runner, entry.summary]))]));
}

/** The runner of a case's most recent summary, whichever runner wrote it. */
export function lastRunner(outputDir: string, testCase: CigeCase): string | undefined {
  if (!existsSync(outputDir)) return undefined;
  const base = baseName(testCase);
  let latest: { runner: string; at: string } | undefined;
  for (const file of readdirSync(outputDir)) {
    if (!file.endsWith(SUMMARY_SUFFIX)) continue;
    const target = path.join(outputDir, file);
    try {
      const summary = JSON.parse(readFileSync(target, 'utf8')) as CigeRunSummary;
      if ((summary.variant === undefined ? summary.testId : `${summary.testId}.${summary.variant}`) !== base) continue;
      const at = `${summary.runDate ?? ''}|${statSync(target).mtime.toISOString()}`;
      if (latest === undefined || latest.at < at) latest = { runner: summaryRunner(target), at };
    } catch {
      // Not a summary.
    }
  }
  return latest?.runner;
}

/** The guardrails a runner can only pass to the agent as text for this case, by id and rule kind. */
function advisedGuardrails(testCase: CigeCase, capabilities: CigeCapabilities): string[] {
  return testCase.guardrails.flatMap((rule) => [
    ...(rule.deny !== undefined && !capabilities.actionEvents ? [`${rule.id} (deny)`] : []),
    ...(rule.extensions?.['x-deny-requests'] !== undefined && !capabilities.networkDeny ? [`${rule.id} (x-deny-requests)`] : []),
  ]);
}

/** Why a runner can't run the case at all; empty when it can. */
function exclusions<Fixtures>(testCase: CigeCase, candidate: RouteCandidate, config: Pick<CigeConfig<Fixtures>, 'plugins'>): string[] {
  const { capabilities } = candidate;
  const why: string[] = [];
  if (!candidate.availability.ok) why.push(`not available: ${candidate.availability.reason ?? 'it says no'}`);
  const platforms = testCase.context.platforms;
  if (platforms !== undefined && !capabilities.platforms.includes('*') && !platforms.some((platform) => capabilities.platforms.includes(platform))) {
    why.push(`runs ${capabilities.platforms.join(', ')}, not ${platforms.join(', ')}`);
  }
  for (const kind of missingStepKinds(testCase, config.plugins ?? [], candidate.name)) why.push(`no plugin registers step kind "${kind}" for it`);
  if (testCase.context.session !== undefined && !capabilities.sessions) why.push("can't restore the saved session the case needs");
  return why;
}

interface Ranked {
  readonly name: string;
  readonly advised: readonly string[];
  readonly lastInfrastructure?: string;
  readonly replayReady: boolean;
  readonly prefer: number;
}

/** Ranks two eligible runners: negative when `a` is better. Returns the rule that decided, too. */
function compare(a: Ranked, b: Ranked): { order: number; rule: 'guardrails' | 'infrastructure' | 'replay' | 'prefer' } {
  if (a.advised.length !== b.advised.length) return { order: a.advised.length - b.advised.length, rule: 'guardrails' };
  const infra = Number(a.lastInfrastructure !== undefined) - Number(b.lastInfrastructure !== undefined);
  if (infra !== 0) return { order: infra, rule: 'infrastructure' };
  const replay = Number(b.replayReady) - Number(a.replayReady);
  if (replay !== 0) return { order: replay, rule: 'replay' };
  return { order: a.prefer - b.prefer, rule: 'prefer' };
}

function describe(winner: Ranked, runnerUp: Ranked | undefined, rule: ReturnType<typeof compare>['rule'] | undefined): string {
  if (runnerUp === undefined) return `${winner.name}: the only runner that can run it`;
  switch (rule) {
    case 'guardrails':
      return winner.advised.length === 0
        ? `${winner.name}: enforces every guardrail; ${runnerUp.name} would only advise ${runnerUp.advised.join(', ')}`
        : `${winner.name}: advises the fewest guardrails (${winner.advised.join(', ')}); ${runnerUp.name} would advise ${runnerUp.advised.join(', ')}`;
    case 'infrastructure':
      return `${winner.name}: ${runnerUp.name} failed as infrastructure on its last run of the case (${runnerUp.lastInfrastructure})`;
    case 'replay':
      return `${winner.name}: replays its last passing run of the case, with no model calls`;
    default:
      return `${winner.name}: first in auto.prefer among equals (${[winner.name, runnerUp.name].join(', ')})`;
  }
}

/** The runner `auto` picks for one resolved case, and why. */
export function routeCase<Fixtures>(
  testCase: CigeCase,
  candidates: readonly RouteCandidate[],
  history: RunHistory,
  config: Pick<CigeConfig<Fixtures>, 'plugins' | 'auto'>,
): RouteDecision {
  const prefer = config.auto?.prefer ?? DEFAULT_PREFER;
  const past = history.get(baseName(testCase));
  const considered: RouteConsidered[] = [];
  const ranked: Ranked[] = [];
  for (const candidate of candidates) {
    const excluded = exclusions(testCase, candidate, config);
    if (excluded.length > 0) {
      considered.push({ name: candidate.name, eligible: false, why: excluded });
      continue;
    }
    const last = past?.get(candidate.name);
    const entry: Ranked = {
      name: candidate.name,
      advised: advisedGuardrails(testCase, candidate.capabilities),
      ...(last?.failureType === 'infrastructure' ? { lastInfrastructure: last.runDate } : {}),
      replayReady: candidate.capabilities.replay === 'deterministic' && last?.result === 'pass',
      prefer: prefer.includes(candidate.name) ? prefer.indexOf(candidate.name) : prefer.length + candidates.indexOf(candidate),
    };
    ranked.push(entry);
    considered.push({
      name: candidate.name,
      eligible: true,
      why: [
        ...(entry.advised.length === 0 ? ['enforces every guardrail'] : [`only advises ${entry.advised.join(', ')}`]),
        ...(entry.lastInfrastructure === undefined ? [] : [`failed as infrastructure on its last run (${entry.lastInfrastructure})`]),
        ...(entry.replayReady ? ['replays its last passing run'] : []),
      ],
    });
  }
  if (ranked.length === 0) {
    return { reason: `no runner can run it: ${considered.map((entry) => `${entry.name} ${entry.why.join('; ')}`).join('. ') || 'none is configured or installed'}`, considered };
  }
  const sorted = ranked.toSorted((a, b) => compare(a, b).order);
  const [winner, runnerUp] = sorted as [Ranked, Ranked | undefined];
  return { runner: winner.name, reason: describe(winner, runnerUp, runnerUp === undefined ? undefined : compare(winner, runnerUp).rule), considered };
}

/** The selection a summary records for a routed case. */
export function selectionOf(decision: RouteDecision): CigeRunnerSelection | undefined {
  return decision.runner === undefined ? undefined : { by: 'auto', reason: decision.reason };
}
