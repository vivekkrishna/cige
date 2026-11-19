/**
 * The runner contract: what an adapter implements so a CIGE case runs on
 * its tool. The case and the model stay runner-free; the adapter is picked
 * when the tests run, by `--runner`, the environment's `runner`, or the
 * config's `runner`.
 *
 * A runner is either hosted (its own test runner owns the loop, as e2e does:
 * the adapter registers the cases with it and reads its report back) or
 * owned (it has no test runner, as Vibium does: `cige run` owns the loop and
 * opens one session per case through `start`).
 */

import type { CigeErrorCode } from './errors.ts';
import type { CigeOp } from './plan.ts';
import type { AnyPlugin } from './plugins.ts';
import type { CigeCase } from './schema.ts';
import type { CigeOutcome } from './signals.ts';

export interface CigeCapabilities {
  /** The `Context.platforms` values it can run. */
  readonly platforms: readonly string[];
  /** Who owns the test loop. */
  readonly mode: 'hosted' | 'owned';
  /** How a rerun repeats a passing path: recorded and replayed, agentic every run, or not at all. */
  readonly replay: 'deterministic' | 'agentic' | 'none';
  /** It reports every action of an act step, so `deny.actions`, `deny.summary`, and plugin `onAction` are enforced. */
  readonly actionEvents: boolean;
  /** It can block requests, so a guardrail's `x-deny-requests` is enforced. */
  readonly networkDeny: boolean;
  /** It can judge a saved recording offline (`cige rejudge`). */
  readonly archiveJudge: boolean;
  /** It restores a saved `Context.session`. */
  readonly sessions: boolean;
}

export type CigeActOp = Extract<CigeOp, { readonly kind: 'act' }>;
export type CigeVerifyOp = Extract<CigeOp, { readonly kind: 'verify' }>;
export type CigeJudgeOp = Extract<CigeOp, { readonly kind: 'judge' }>;

/** Where a hook or step kind threw, for `CigeSession.keeps`. */
export type CigeThrowSite = 'precondition' | 'use' | 'evidence';

/**
 * One case's run on a runner. An operation resolves when it holds and
 * throws when it doesn't: a hosted runner's own error, so its report
 * records it as it always has, or a `CigeError` carrying the signals.
 */
export interface CigeSession<Fixtures = unknown> {
  /** The runner's name, which plugins' `runners` are matched against. */
  readonly runner: string;
  /** What hooks and step kinds get: e2e's test fixtures, Vibium's `{ browser, page }`. */
  readonly fixtures: Fixtures;
  open(url: string): Promise<void>;
  act(op: CigeActOp): Promise<void>;
  verify(op: CigeVerifyOp): Promise<void>;
  judge(op: CigeJudgeOp): Promise<void>;
  /** Wraps one operation in the runner's record: a recording group, a test step. */
  group?<T>(op: CigeOp, run: () => Promise<T>): Promise<T>;
  /** The error a failure with this code is, on this runner. */
  failure(code: CigeErrorCode, message: string, options: { readonly cause?: unknown; readonly op: CigeOp }): Error;
  /** Whether an error a hook or step kind threw already carries this runner's verdict, so it is rethrown as is. */
  keeps(cause: unknown, site: CigeThrowSite): boolean;
  /** An error a hook threw, as this runner reports it (e2e turns a `CigeError` into an `AgentError`). */
  translate?(cause: unknown): unknown;
  /** Ends the session and hands back what it recorded. Owned runners only. */
  stop?(): Promise<CigeSessionArtifacts>;
}

export interface CigeSessionArtifacts {
  /** The recording the session wrote: a trace, a zip. */
  readonly recording?: string;
  /** The ids of the groups in it, one per operation. */
  readonly groups?: readonly string[];
  /** Any other files, project-relative or absolute. */
  readonly artifacts?: readonly string[];
  /** The runner's native record of the case, for plugins' `classify`. */
  readonly native?: unknown;
}

/** The environment a case runs in, as the config declares it. */
export interface CigeResolvedEnvironment {
  readonly name?: string;
  readonly baseURL?: string;
}

/** What an owned runner starts a case with. */
export interface CigeStartContext {
  readonly testCase: CigeCase;
  readonly environment: CigeResolvedEnvironment;
  readonly plugins: readonly AnyPlugin[];
  /** The directory the run summaries go to: a recording lands under it. */
  readonly outputDir: string;
  /** The name the case's summary is written under, file-safe; a recording is named after it. */
  readonly name: string;
  /** 0 for the first attempt, then 1, 2, … for each retry. */
  readonly attempt: number;
}

/** What `cige rejudge` asks an archive-judging runner: the Intent of a case, against a stored recording. */
export interface CigeRejudgeInput {
  readonly testCase: CigeCase;
  readonly recording: string;
}

export interface CigeRunner<Fixtures = unknown> {
  /** Lowercase letters, digits, and dashes: `e2e`, `vibium`. Names its summaries and `--runner`. */
  readonly name: string;
  /** The tool's version, when it is installed; `unknown` otherwise. */
  readonly version: string;
  readonly capabilities: CigeCapabilities;
  /** Opens one case's session. Owned runners only. */
  start?(context: CigeStartContext): Promise<CigeSession<Fixtures>>;
  /** Judges the Intent against a stored recording. Runners with `archiveJudge` only. */
  rejudge?(input: CigeRejudgeInput): Promise<CigeOutcome>;
  /**
   * Whether it can run a case right now, without starting anything: its tool
   * installed, a model configured. `auto` routing skips a runner that says no.
   * Absent: always available.
   */
  availability?(): CigeAvailability;
}

export interface CigeAvailability {
  readonly ok: boolean;
  /** Why not, when it can't. */
  readonly reason?: string;
}

/** How `auto` picked a case's runner, as the summary records it. */
export interface CigeRunnerSelection {
  readonly by: 'auto';
  readonly reason: string;
}
